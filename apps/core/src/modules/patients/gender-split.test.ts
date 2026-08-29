import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import { patientIdentityVersions, patients, registrationConfig } from "../../kernel/db/schema";
import { getPatientSummaries, registerPatient, updatePatient } from "./registration";
import { searchPatients } from "./search";
import { resolveFieldClass, resolveIdentityAt } from "./identity";

/**
 * PLAN 22c-A T4 — ADMINISTRATIVE GENDER SPLIT FROM CLINICAL SEX (A11–A14).
 *
 * The split is two columns and one rule about who reads which. Spike S6 measured that NO clinical
 * reader of `sex` exists anywhere in the tree today — all 52 non-test references are display,
 * document, search or form — which is exactly why this is affordable now and would not be
 * affordable in the phase that ships a lab.
 *
 * A11's other half is NOT ASSERTED HERE and the omission is deliberate. "Every existing row has
 * `administrative_gender = sex` after 0043" is a claim about 24 production rows; a test database
 * is migrated from empty, so the backfill statement runs over nothing and would prove nothing.
 * What IS asserted below is the RULE — that `registerPatient` seeds from `sex` exactly as the
 * migration did — so the two populations cannot diverge. The production half is the deploy's
 * precondition query, written into the phase document rather than dressed up as a green test.
 */

const CLERK: Actor = { type: "user", id: "01USERCLERK00000000000001" };

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
afterAll(async () => teardown());
beforeEach(async () => {
  await truncateAll(db);
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
});

async function makePatient(over: Record<string, unknown> = {}): Promise<string> {
  const { patient } = await withTx(db, (tx) =>
    registerPatient(tx, CLERK, { name: "Asha Devi", sex: "female", phone: "9876543210", ageYears: 30, ...over } as never));
  return patient.id;
}

describe("A11 — administrative gender seeds from clinical sex, by the same rule the migration used", () => {
  it("a counter registration with no explicit gender takes `sex`", async () => {
    const id = await makePatient({ sex: "other" });
    const [row] = await db.select().from(patients).where(eq(patients.id, id));
    expect(row!.administrativeGender).toBe("other");
    expect(row!.sex).toBe("other");
  });

  it("preserves 'unknown' rather than substituting a guess", async () => {
    // 4 of 24 production patients carry 'unknown' or 'other' (spike S3). A backfill that mapped
    // them to a default would have invented a legal gender for 17% of the master.
    const id = await makePatient({ sex: "unknown" });
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.administrativeGender).toBe("unknown");
  });

  it("an explicit administrative gender overrides the seed — the two are genuinely independent", async () => {
    const id = await makePatient({ sex: "male", administrativeGender: "female" });
    const [row] = await db.select().from(patients).where(eq(patients.id, id));
    expect(row!.sex).toBe("male");
    expect(row!.administrativeGender).toBe("female");
  });

  it("the database refuses a patient with no administrative gender — there is no column default", async () => {
    // A DB default would be a CONSTANT. A constant rendered as a person's legal gender on a
    // discharge summary is precisely the failure this split exists to prevent, so the column is
    // NOT NULL with nothing to fall back on and every write site must answer the question.
    const [row] = await db.select().from(patients).limit(1);
    expect(row).toBeUndefined();
    await expect(
      db.execute(
        // eslint-disable-next-line no-restricted-syntax -- exercising the constraint, not the model
        require("drizzle-orm").sql`insert into patients (id, uhid, name, sex, created_by, updated_by)
          values ('p-none', 'HMS-00000009-1', 'No Gender', 'male', 'u1', 'u1')`,
      ),
    ).rejects.toThrow(/administrative_gender/);
  });
});

describe("A12/A13 — the field classes decide which door a correction goes through", () => {
  it("A12 — amending administrative gender mints a version (Class I)", async () => {
    const id = await makePatient();
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { administrativeGender: "other" }, { reasonClass: "legal_change" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.version === 2)!.administrativeGender).toBe("other");
  });

  it("A13 — amending clinical sex mints NO version (Class III)", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { sex: "other" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(1);
  });

  it("the classification itself, stated so a swap fails loudly", () => {
    // Swapping these two obstructs a NALSA right in one direction and records a clinical
    // correction as an identity amendment in the other.
    expect(resolveFieldClass("administrativeGender")).toBe("I");
    expect(resolveFieldClass("sex")).toBe("III");
  });
});

describe("A14 — display, document and search surfaces read administrative gender", () => {
  it("a summary reports administrative gender, and has no `sex` field at all", async () => {
    const id = await makePatient({ sex: "male" });
    const [s] = await getPatientSummaries(db, CLERK, [id]);
    expect(s!.administrativeGender).toBe("male");
    // Structural, not cosmetic: a display surface cannot read the clinical value by habit if the
    // clinical value is not on the payload.
    expect("sex" in (s as object)).toBe(false);
  });

  it("A GENDER AMENDMENT MOVES THE SUMMARY AND A SEX AMENDMENT DOES NOT — the split, proved", async () => {
    const id = await makePatient({ sex: "male" });

    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { sex: "female" }));
    expect((await getPatientSummaries(db, CLERK, [id]))[0]!.administrativeGender).toBe("male");

    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { administrativeGender: "female" }, { reasonClass: "legal_change" }));
    expect((await getPatientSummaries(db, CLERK, [id]))[0]!.administrativeGender).toBe("female");

    // …and the clinical column kept its own value throughout, independent of the display one.
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.sex).toBe("female");
  });

  it("search results report administrative gender", async () => {
    const id = await makePatient({ sex: "male" });
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { administrativeGender: "other" }, { reasonClass: "legal_change" }));
    const hits = await searchPatients(db, CLERK, "Asha");
    expect(hits.find((h) => h.id === id)!.administrativeGender).toBe("other");
  });

  it("the resolver returns the gender AS OF an earlier instant, not today's", async () => {
    // A14's as-of half. The two shipped print surfaces are converted in kernel-D T6 (review §4);
    // what this proves is that the value they will ask for is already there and already correct.
    const id = await makePatient({ sex: "male" });
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { administrativeGender: "female" }, { reasonClass: "legal_change" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    const v2 = rows.find((r) => r.version === 2)!;
    const asOf = await resolveIdentityAt(db, id, new Date(v2.validFrom.getTime() - 1));
    expect(asOf!.administrativeGender).toBe("male");
    expect((await resolveIdentityAt(db, id, v2.validFrom))!.administrativeGender).toBe("female");
  });
});
