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

  /**
   * THE 2026-08-25 FORMAT'S SEARCH LANES. The format change (nine characters, no separators) only
   * pays off if the box forgives how a desk actually types an id, so each of these is a way a real
   * lookup arrives rather than a permutation for its own sake. The UHIDs are sliced out of the
   * allocated value instead of being written as literals: `truncateAll` does not reset `uhid_seq`,
   * so the serial differs between runs and any hard-coded id here would be a time bomb.
   */
  it("finds a patient by a UHID typed WITHOUT the prefix letter — the numeric-keypad path", async () => {
    const { ashaUhid } = await seedThree();
    const bare = ashaUhid.slice(3); // 8 digits: the 7-digit serial and its check digit, no "HMS"
    expect((await searchPatients(db, clerk, bare)).map((r) => r.uhid)).toEqual([ashaUhid]);
  });

  it("finds a patient by the LEADING serial digits, with the check digit not yet typed", async () => {
    // A serial copied out of a report, or off an older system that never carried a check digit —
    // a trailing-anchored match would miss every one of these.
    const { ashaUhid } = await seedThree();
    const serial = ashaUhid.slice(3, 10);
    expect((await searchPatients(db, clerk, serial)).map((r) => r.uhid)).toEqual([ashaUhid]);
    expect((await searchPatients(db, clerk, `hms${serial}`)).map((r) => r.uhid)).toEqual([ashaUhid]);
  });

  it("finds a patient by the TRAILING digits read off a card", async () => {
    // The other half of the desk, and the reason the lane is a substring rather than a prefix:
    // the leading `U123` is shared by every patient for the hospital's first 55,000 registrations.
    const { ashaUhid } = await seedThree();
    expect((await searchPatients(db, clerk, ashaUhid.slice(-4))).map((r) => r.uhid)).toContain(ashaUhid);
  });

  it("treats spaces and hyphens inside an ID as punctuation", async () => {
    const { ashaUhid } = await seedThree();
    const spaced = `${ashaUhid.slice(0, 3)} ${ashaUhid.slice(3, 7)}-${ashaUhid.slice(7)}`;
    expect((await searchPatients(db, clerk, spaced)).map((r) => r.uhid)).toEqual([ashaUhid]);
  });

  it("a digit run inside the UHID window still searches PHONES — the lanes are OR'd, not chosen between", async () => {
    // Guards the regression where the UHID lane returns early and swallows the phone lane: five
    // digits are both a plausible phone prefix and a plausible UHID fragment, and a desk that
    // typed a phone prefix must not be told there is no such patient.
    await seedThree();
    const hits = await searchPatients(db, clerk, "98765");
    expect(hits.map((r) => r.name).sort()).toEqual(["Asha Devi", "Ashok Kumar"]);
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
