import { isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { retentionLegalHolds } from "./retention";
import { patients } from "./patients";
import type { Db } from "../client";

const PATIENT = "01HRETENTIONPATIENT00001";

const hold = (id: string, over: Partial<typeof retentionLegalHolds.$inferInsert> = {}) => ({
  id, reason: "W.P. 1174/2026 — preserve all records", createdBy: "u1", ...over,
});

describe("retention_legal_holds table", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000009-1", name: "Asha Devi", sex: "female", administrativeGender: "female",
      createdBy: "u1", updatedBy: "u1",
    });
  });
  afterAll(async () => { await teardown(); });

  it("round-trips a GLOBAL hold — a null patient_id is the hold that covers everyone", async () => {
    await db.insert(retentionLegalHolds).values(hold("01HHOLD0000000000000GLOBAL"));
    const rows = await db.select().from(retentionLegalHolds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBeNull(); // null = global, not "missing"
    expect(rows[0]!.releasedAt).toBeNull(); // null = ACTIVE
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips a PATIENT-scoped hold", async () => {
    await db.insert(retentionLegalHolds).values(hold("01HHOLD000000000000PATIENT", { patientId: PATIENT }));
    const rows = await db.select().from(retentionLegalHolds);
    expect(rows[0]!.patientId).toBe(PATIENT);
  });

  it("refuses a hold naming a patient who does not exist", async () => {
    // The FK is the reason `null` can mean GLOBAL: without it a typo'd id would be a hold that
    // silently protects nobody, and nothing would ever say so.
    await expect(
      db.insert(retentionLegalHolds).values(hold("01HHOLD00000000000000BAD1", { patientId: "01HNOSUCHPATIENT00000001" })),
    ).rejects.toThrow();
  });

  it("refuses a hold with no reason — a hold nobody can explain is not a hold", async () => {
    await expect(
      db.insert(retentionLegalHolds).values({ id: "01HHOLD00000000000000BAD2", createdBy: "u1" } as typeof retentionLegalHolds.$inferInsert),
    ).rejects.toThrow();
  });

  it("distinguishes ACTIVE from RELEASED by released_at, and a release deletes nothing", async () => {
    const RELEASED_AT = new Date("2026-08-20T10:00:00.000Z");
    await db.insert(retentionLegalHolds).values([
      hold("01HHOLD0000000000000ACTIVE"),
      hold("01HHOLD00000000000RELEASED", { patientId: PATIENT, releasedAt: RELEASED_AT }),
    ]);

    // The query T5's sweep makes: an ACTIVE hold is one whose released_at is still null.
    const active = await db.select().from(retentionLegalHolds).where(isNull(retentionLegalHolds.releasedAt));
    expect(active.map((h) => h.id)).toEqual(["01HHOLD0000000000000ACTIVE"]);
    // And the released one is still on the record — the row survives its own release.
    expect(await db.select().from(retentionLegalHolds)).toHaveLength(2);
  });
});
