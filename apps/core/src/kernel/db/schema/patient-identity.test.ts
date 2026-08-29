import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { patients, patientIdentityVersions } from "./index";
import type { Db } from "../client";

/**
 * PLAN 22c-A T1 — migration 0043's structural guarantees, each one EXECUTED rather than read out
 * of `information_schema`. "The trigger exists in pg_trigger" proves nothing (the 0012
 * immutability test says so in as many words and this file follows it): every assertion below
 * issues the real statement and observes what the database does with it.
 *
 * What is deliberately NOT asserted here: the 0043 DATA backfill. A test database is migrated from
 * empty, so `UPDATE patients SET identity_assurance = 'staff_verified'` and the version-1 insert
 * both run over zero rows and prove nothing about the 24 production rows they exist for. That
 * claim belongs to the deploy's precondition query, and it is written into the phase document's
 * deploy section rather than dressed up as a passing test here.
 */
describe("patient identity spine — 0043 structure", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  const base = {
    id: "01PATIENT0000000000000001",
    uhid: "HMS-00000001-5",
    name: "Asha Devi",
    sex: "female",
    administrativeGender: "female",
    createdBy: "u1",
    updatedBy: "u1",
  };

  const version1 = {
    id: "01VERSION0000000000000001",
    patientId: base.id,
    version: 1,
    name: "Asha Devi",
    administrativeGender: "female",
    identityAssurance: "staff_verified",
    validFrom: new Date("2026-08-01T00:00:00.000Z"),
    createdBy: "u1",
  };

  it("defaults a NEW patient to self_declared — the ladder's floor, not the backfill's value", async () => {
    await db.insert(patients).values(base);
    const [row] = await db.select().from(patients);
    // DD2: the column default serves the patient who asserts their own identity from 22c-B
    // onward. The 24 rows that predate this migration were set to `staff_verified` by 0043
    // instead, and that divergence is the whole reason the migration was hand-written.
    expect(row!.identityAssurance).toBe("self_declared");
  });

  it("refuses a patient with no administrative gender — no column default, by decision", async () => {
    // A DB-level default would be a CONSTANT, and a constant rendered as a person's legal gender
    // on a discharge summary is exactly the failure DD4 splits the field to prevent. The column
    // is NOT NULL with no default so that every write site has to answer the question;
    // `registerPatient` answers it with `?? input.sex`.
    await expect(
      db.execute(sql`insert into patients (id, uhid, name, sex, created_by, updated_by)
                     values ('p-no-gender', 'HMS-00000002-3', 'No Gender', 'male', 'u1', 'u1')`),
    ).rejects.toThrow(/administrative_gender/);
  });

  it("round-trips a version row and keeps the Class I field set together", async () => {
    await db.insert(patients).values(base);
    await db.insert(patientIdentityVersions).values(version1);
    const [row] = await db.select().from(patientIdentityVersions);
    expect(row).toMatchObject({
      patientId: base.id, version: 1, name: "Asha Devi",
      administrativeGender: "female", identityAssurance: "staff_verified",
    });
    // DD3 — the full field set, never a diff. `dob` absent means "this person had no recorded
    // date of birth then", which is a fact about the version and not a gap in it.
    expect(row!.dob).toBeNull();
    expect(row!.reasonClass).toBeNull();
  });

  it("REFUSES an UPDATE — append-only is enforced by the database, not by convention", async () => {
    await db.insert(patients).values(base);
    await db.insert(patientIdentityVersions).values(version1);
    await expect(
      db.execute(sql`update patient_identity_versions set name = 'Rewritten' where version = 1`),
    ).rejects.toThrow(/patient_identity_immutable/);
    const [row] = await db.select().from(patientIdentityVersions);
    expect(row!.name).toBe("Asha Devi");
  });

  it("REFUSES a DELETE — a version that can be removed is not a version", async () => {
    await db.insert(patients).values(base);
    await db.insert(patientIdentityVersions).values(version1);
    await expect(
      db.execute(sql`delete from patient_identity_versions where version = 1`),
    ).rejects.toThrow(/patient_identity_immutable/);
    expect(await db.select().from(patientIdentityVersions)).toHaveLength(1);
  });

  it("refuses a duplicate version number for one patient", async () => {
    await db.insert(patients).values(base);
    await db.insert(patientIdentityVersions).values(version1);
    await expect(
      db.insert(patientIdentityVersions).values({ ...version1, id: "01VERSION0000000000000002", name: "Asha D." }),
    ).rejects.toThrow(/patient_identity_versions_patient_version_ux/);
  });

  it("refuses a version for a patient that does not exist", async () => {
    await expect(
      db.insert(patientIdentityVersions).values({ ...version1, patientId: "no-such-patient" }),
    ).rejects.toThrow(/patient_id_patients_id_fk/);
  });
});
