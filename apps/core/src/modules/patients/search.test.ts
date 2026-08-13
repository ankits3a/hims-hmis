import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { patientPhotos, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { registerPatient } from "./registration";
import { searchPatients } from "./search";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

describe("searchPatients", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" });
  });

  async function seedThree(): Promise<{ ashaUhid: string }> {
    const asha = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Ashok Kumar", sex: "male", phone: "9876500000", altPhone: "8000000001" }),
    );
    await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Binod Singh", sex: "male", phone: "7012345678" }),
    );
    return { ashaUhid: asha.patient.uhid };
  }

  it("digit queries search phone AND alt-phone by prefix", async () => {
    await seedThree();
    const both = await searchPatients(db, clerk, "98765");
    expect(both.map((r) => r.name).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
    const viaAlt = await searchPatients(db, clerk, "80000");
    expect(viaAlt.map((r) => r.name)).toEqual(["Ashok Kumar"]);
  });

  it("UHID-shaped queries match exactly, case-insensitively on the prefix", async () => {
    const { ashaUhid } = await seedThree();
    const hits = await searchPatients(db, clerk, ashaUhid.toLowerCase());
    expect(hits).toHaveLength(1);
    expect(hits[0]!.uhid).toBe(ashaUhid);
  });

  it("text queries search name by case-insensitive prefix, with LIKE metacharacters inert", async () => {
    await seedThree();
    const hits = await searchPatients(db, clerk, "ash");
    expect(hits.map((r) => r.name)).toEqual(["Asha Devi", "Ashok Kumar"]); // name asc
    expect(await searchPatients(db, clerk, "sha")).toEqual([]); // prefix, not substring — deliberate Phase-1 scope
    expect(await searchPatients(db, clerk, "a%")).toEqual([]); // % is a literal, matches nobody
  });

  it("returns hasPhoto without ever selecting bytes", async () => {
    await seedThree();
    const asha = (await searchPatients(db, clerk, "9876543210"))[0]!;
    expect(asha.hasPhoto).toBe(false);
    await db.insert(patientPhotos).values({
      patientId: asha.id, mimeType: "image/jpeg", bytes: Buffer.from([0xff]), updatedBy: "t",
    });
    expect((await searchPatients(db, clerk, "9876543210"))[0]!.hasPhoto).toBe(true);
  });

  it("excludes confidential patients unless the caller holds patients.confidential.read", async () => {
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_desk", "VIP Desk");
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    const holder = await createUser(db, { username: "holder2", fullName: "H", password: "p1234567" });
    await assignRole(db, { userId: holder.id, roleKey: "vip_desk", scopeType: "hospital" });

    await withTx(db, (tx) =>
      registerPatient(tx, clerk, {
        name: "Vip Person", sex: "male", phone: "9111111111", isConfidential: true, alias: "Patient V",
      }),
    );
    expect(await searchPatients(db, clerk, "9111111111")).toEqual([]);
    const seen = await searchPatients(db, { type: "user", id: holder.id }, "9111111111");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isConfidential).toBe(true);
  });

  it("short and non-user queries", async () => {
    await seedThree();
    expect(await searchPatients(db, clerk, " 9 ")).toEqual([]); // trimmed length < 2
    await expect(searchPatients(db, { type: "agent", id: "a1" }, "asha")).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
