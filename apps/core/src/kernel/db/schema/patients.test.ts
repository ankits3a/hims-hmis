import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  patients, patientPhotos, patientAllergies, patientGuardians,
  patientMergeRequests, registrationConfig,
} from "./index";
import type { Db } from "../client";

describe("patients schema", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  const basePatient = {
    id: "01PATIENT0000000000000001",
    uhid: "HMS-00000001-5",
    name: "Asha Devi",
    sex: "female",
    createdBy: "u1",
    updatedBy: "u1",
  };

  it("round-trips a patient with defaults applied", async () => {
    await db.insert(patients).values(basePatient);
    const rows = await db.select().from(patients);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.language).toBe("hi");
    expect(row.status).toBe("active");
    expect(row.qrVersion).toBe(1);
    expect(typeof row.qrVersion).toBe("number"); // integer column — the string/number trap class
    expect(row.isConfidential).toBe(false);
    expect(row.sensitiveContext).toBe(false);
    expect(row.dobEstimated).toBe(false);
    expect(row.abhaVerificationStatus).toBe("none");
    expect(row.phone).toBeNull();
    expect(row.dob).toBeNull();
    expect(row.mergedIntoPatientId).toBeNull();
  });

  it("round-trips a DATE dob as a Date at day precision", async () => {
    await db.insert(patients).values({ ...basePatient, dob: new Date(Date.UTC(2010, 3, 15)) });
    const rows = await db.select().from(patients);
    const dob = rows[0]!.dob!;
    expect(dob).toBeInstanceOf(Date);
    expect(dob.getUTCFullYear()).toBe(2010);
    expect(dob.getUTCMonth()).toBe(3);
    expect(dob.getUTCDate()).toBe(15);
  });

  it("rejects a duplicate uhid", async () => {
    await db.insert(patients).values(basePatient);
    await expect(
      db.insert(patients).values({ ...basePatient, id: "01PATIENT0000000000000002" }),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("round-trips photo bytes as a Buffer", async () => {
    await db.insert(patients).values(basePatient);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await db.insert(patientPhotos).values({
      patientId: basePatient.id, mimeType: "image/jpeg", bytes, updatedBy: "u1",
    });
    const rows = await db.select().from(patientPhotos);
    expect(Buffer.isBuffer(rows[0]!.bytes)).toBe(true);
    expect(Buffer.compare(rows[0]!.bytes, bytes)).toBe(0);
  });

  it("enforces one photo per patient (PK) and the patient FK", async () => {
    await expect(
      db.insert(patientPhotos).values({
        patientId: "01NOSUCHPATIENT0000000000", mimeType: "image/jpeg",
        bytes: Buffer.from([1]), updatedBy: "u1",
      }),
    ).rejects.toThrow(/foreign key/i);
    await db.insert(patients).values(basePatient);
    const photo = { patientId: basePatient.id, mimeType: "image/jpeg", bytes: Buffer.from([1]), updatedBy: "u1" };
    await db.insert(patientPhotos).values(photo);
    await expect(db.insert(patientPhotos).values(photo)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows only ONE pending merge request per loser (partial unique index)", async () => {
    await db.insert(patients).values(basePatient);
    await db.insert(patients).values({ ...basePatient, id: "01PATIENT0000000000000002", uhid: "HMS-00000002-3" });
    const req = {
      id: "01MERGEREQ0000000000000001",
      winnerId: basePatient.id,
      loserId: "01PATIENT0000000000000002",
      approvalId: "01APPROVAL000000000000001",
      requestNote: "duplicate registration",
      snapshot: { winnerBefore: {}, loserBefore: {} },
      requestedBy: "u1",
    };
    await db.insert(patientMergeRequests).values(req);
    await expect(
      db.insert(patientMergeRequests).values({ ...req, id: "01MERGEREQ0000000000000002", approvalId: "01APPROVAL000000000000002" }),
    ).rejects.toThrow(/duplicate key|unique/i);
    // a non-'requested' status frees the slot
    await db.execute(sql`update patient_merge_requests set status = 'executed' where id = ${req.id}`);
    await db.insert(patientMergeRequests).values({ ...req, id: "01MERGEREQ0000000000000003", approvalId: "01APPROVAL000000000000003" });
  });

  it("uhid_seq allocates increasing values and survives concurrent nextval", async () => {
    const first = await db.execute(sql`select nextval('uhid_seq') as n`);
    const second = await db.execute(sql`select nextval('uhid_seq') as n`);
    // nextval returns bigint → pg hands it back as TEXT; every consumer must force Number (T2 does)
    expect(Number(second.rows[0]!.n)).toBe(Number(first.rows[0]!.n) + 1);
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => db.execute(sql`select nextval('uhid_seq') as n`)),
    );
    const values = batch.map((r) => Number(r.rows[0]!.n));
    expect(new Set(values).size).toBe(20);
  });

  it("registration_config and guardians round-trip with defaults", async () => {
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "u1" });
    const cfg = await db.select().from(registrationConfig);
    expect(cfg[0]!.uhidPrefix).toBe("HMS");

    await db.insert(patients).values(basePatient);
    await db.insert(patientGuardians).values({
      id: "01GUARDIAN000000000000001", patientId: basePatient.id,
      name: "Ram Prasad", relationship: "father", createdBy: "u1",
    });
    const g = (await db.select().from(patientGuardians))[0]!;
    expect(g.status).toBe("active");
    expect(g.authorityMessages).toBe(true);
    expect(g.authorityConsents).toBe(true);
    expect(g.authorityDsr).toBe(false);
    expect(g.authorityBills).toBe(true);
    expect(g.idVerified).toBe(false);

    await db.insert(patientAllergies).values({
      id: "01ALLERGY0000000000000001", patientId: basePatient.id,
      substance: "penicillin", source: "registration", recordedBy: "u1",
    });
    const a = (await db.select().from(patientAllergies))[0]!;
    expect(a.status).toBe("active");
    expect(a.severity).toBeNull();
  });
});
