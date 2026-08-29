import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import { patientIdentityVersions, patients, events, registrationConfig } from "../../kernel/db/schema";
import { registerPatient, updatePatient } from "./registration";
import {
  assuranceAfterAmendment, assuranceRank, resolveFieldClass, touchesIdentity,
  upgradeAssurance, resolveIdentityAt, IDENTITY_ASSURANCE,
} from "./identity";

/**
 * PLAN 22c-A T3 — IDENTITY VERSIONS, FIELD CLASSES, THE ASSURANCE LADDER (A6–A10).
 */

const CLERK: Actor = { type: "user", id: "01USERCLERK00000000000001" };
const PATIENT_ACTOR: Actor = { type: "patient", id: "01PATIENTCRED00000000001" };

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
afterAll(async () => teardown());
beforeEach(async () => {
  await truncateAll(db);
  // `onConflictDoNothing` matches `test/helpers/opd.ts` — this row survives a killed run and a
  // bare insert then collides on the next one, which is a flake rather than a finding.
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
});

async function makePatient(over: Record<string, unknown> = {}): Promise<string> {
  const { patient } = await withTx(db, (tx) =>
    registerPatient(tx, CLERK, { name: "Asha Devi", sex: "female", phone: "9876543210", ageYears: 30, ...over } as never),
  );
  return patient.id;
}

describe("field classes (DD3/DD4)", () => {
  it("classes the identity-bearing fields as I", () => {
    for (const f of ["name", "dob", "dobEstimated", "administrativeGender", "abhaNumber"]) {
      expect(resolveFieldClass(f)).toBe("I");
    }
  });

  it("classes clinical sex as III and contact fields as II — DD4's ruling, in one assertion", () => {
    // Getting this pair backwards is the failure DD4 exists to prevent: `sex` as Class I would
    // record a clinical correction as a legal identity amendment, and `administrativeGender` as
    // Class III would leave a NALSA gender change with no versioned trace at all.
    expect(resolveFieldClass("sex")).toBe("III");
    expect(resolveFieldClass("administrativeGender")).toBe("I");
    for (const f of ["phone", "altPhone", "addressLine", "pincode", "language", "promotionalOptIn"]) {
      expect(resolveFieldClass(f)).toBe("II");
    }
  });

  it("touchesIdentity is true only when a Class I field is in the set", () => {
    expect(touchesIdentity(["phone", "addressLine"])).toBe(false);
    expect(touchesIdentity(["phone", "name"])).toBe(true);
    expect(touchesIdentity(["sex"])).toBe(false);
  });
});

describe("the assurance ladder (DD2)", () => {
  it("ranks by LADDER order, not by string order", () => {
    // Alphabetically this list is very nearly reversed: abha_verified < id_verified <
    // self_declared < staff_verified. Any comparison that used string order would read a
    // self-declared record as more assured than an ABHA-verified one.
    expect(IDENTITY_ASSURANCE.map(assuranceRank)).toEqual([0, 1, 2, 3]);
    expect(assuranceRank("abha_verified")).toBeGreaterThan(assuranceRank("self_declared"));
    expect([...IDENTITY_ASSURANCE].sort()).not.toEqual([...IDENTITY_ASSURANCE]);
  });

  it("refuses an unknown level rather than ranking it", () => {
    expect(() => assuranceRank("very_verified")).toThrow(/unknown identity assurance/);
  });

  it("A8 — an unevidenced amendment drops to staff_verified, and an evidenced one does not", () => {
    expect(assuranceAfterAmendment("id_verified", null)).toBe("staff_verified");
    expect(assuranceAfterAmendment("abha_verified", null)).toBe("staff_verified");
    // Evidence at or above the record's current level holds the stamp.
    expect(assuranceAfterAmendment("id_verified", "id_verified")).toBe("id_verified");
    expect(assuranceAfterAmendment("abha_verified", "abha_verified")).toBe("abha_verified");
    // Weaker evidence does not.
    expect(assuranceAfterAmendment("abha_verified", "id_verified")).toBe("staff_verified");
    // The floor never rises: a record already at or below staff_verified is untouched.
    expect(assuranceAfterAmendment("staff_verified", null)).toBe("staff_verified");
    expect(assuranceAfterAmendment("self_declared", null)).toBe("self_declared");
  });
});

describe("A6 — a Class I change mints exactly one version, inside the amendment's transaction", () => {
  it("mints one version and one event for a name change", async () => {
    const id = await makePatient();
    const before = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(before).toHaveLength(1); // registration minted v1
    expect(before[0]!.version).toBe(1);

    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { name: "Asha Sharma" }, { reasonClass: "legal_change" }));

    const after = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(after).toHaveLength(2);
    const v2 = after.find((r) => r.version === 2)!;
    expect(v2.name).toBe("Asha Sharma");
    expect(v2.reasonClass).toBe("legal_change");
    // The version carries the FULL Class I set, not a diff (DD3) — the previous version's dob
    // must still be readable from v2 without walking back.
    expect(v2.dob).not.toBeNull();

    const minted = await db.select().from(events).where(eq(events.name, "patient.identity_version_minted"));
    expect(minted).toHaveLength(1);
  });

  it("A6 — A ROLLED-BACK AMENDMENT LEAVES NO VERSION BEHIND", async () => {
    const id = await makePatient();
    // The mint rides the caller's transaction, so a failure anywhere after it must take the
    // version with it. A version that survived would assert a state the patient was never in,
    // and a document could later be re-rendered as a person who never existed.
    await expect(
      withTx(db, async (tx) => {
        await updatePatient(tx, CLERK, id, { name: "Never Committed" }, { reasonClass: "clerical_error" });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow(/deliberate rollback/);

    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Asha Devi");
    const [p] = await db.select().from(patients).where(eq(patients.id, id));
    expect(p!.name).toBe("Asha Devi");
  });

  it("mints for administrative gender — the Class I field the split created", async () => {
    const id = await makePatient();
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { administrativeGender: "other" }, { reasonClass: "legal_change" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.version === 2)!.administrativeGender).toBe("other");
  });
});

describe("A7 — a Class II change mints NO version", () => {
  it("a phone change leaves the version table untouched", async () => {
    const id = await makePatient();
    const { changed } = await withTx(db, (tx) => updatePatient(tx, CLERK, id, { phone: "9000000000" }));
    expect(changed).toEqual(["phone"]);
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(1); // still just registration's v1
  });

  it("a CLINICAL sex change mints no version either — it is Class III (DD4)", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { sex: "other" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(1);
  });

  it("a mixed patch mints ONE version, not one per Class I field", async () => {
    const id = await makePatient();
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { name: "A S", administrativeGender: "other", phone: "9000000001" },
        { reasonClass: "document_correction" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows).toHaveLength(2);
  });
});

describe("A8 — the drop, end to end", () => {
  it("an unevidenced name change on an id_verified record lands at staff_verified", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "id_verified", "AADHAAR-XXXX-1234"));
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.identityAssurance).toBe("id_verified");

    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { name: "Asha Sharma" }, { reasonClass: "patient_request" }));

    const [p] = await db.select().from(patients).where(eq(patients.id, id));
    expect(p!.identityAssurance).toBe("staff_verified");
    // The version records the assurance that stood behind IT, so a document rendered from v2
    // reports staff_verified rather than borrowing v1's stronger claim.
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    expect(rows.find((r) => r.version === 2)!.identityAssurance).toBe("staff_verified");
    const dropped = await db.select().from(events).where(eq(events.name, "patient.identity_assurance_changed"));
    expect(dropped.map((e) => (e.payload as { reason: string }).reason)).toContain("amendment_drop");
  });

  it("an EVIDENCED amendment holds the stamp", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "id_verified", "AADHAAR-XXXX-1234"));
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { name: "Asha Sharma" },
        { reasonClass: "document_correction", evidenceRef: "PASSPORT-9911", evidencedAt: "id_verified" }));
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.identityAssurance).toBe("id_verified");
  });

  it("a Class II change does NOT drop assurance — the drop is about identity, not about editing", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "id_verified", "AADHAAR-XXXX-1234"));
    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { phone: "9000000000" }));
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.identityAssurance).toBe("id_verified");
  });
});

describe("A9 — assurance never rises except by a staff actor, never falls except by A8", () => {
  it("REFUSES a patient actor raising its own assurance", async () => {
    // Self-asserted identity verification is the one thing an assurance ladder must never permit.
    const id = await makePatient();
    await expect(
      withTx(db, (tx) => upgradeAssurance(tx, PATIENT_ACTOR, id, "id_verified", "SELFIE")),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("REFUSES a downgrade through the upgrade door", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "id_verified", "AADHAAR-XXXX-1234"));
    await expect(
      withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "self_declared", null)),
    ).rejects.toMatchObject({ code: "assurance_not_increasing" });
  });

  it("REFUSES a sideways move to the same level", async () => {
    const id = await makePatient();
    await expect(
      withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "staff_verified", null)),
    ).rejects.toMatchObject({ code: "assurance_not_increasing" });
  });

  it("REFUSES id_verified or above with no evidence reference", async () => {
    const id = await makePatient();
    await expect(
      withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "id_verified", "   ")),
    ).rejects.toMatchObject({ code: "evidence_required" });
  });

  it("REFUSES an unknown level", async () => {
    const id = await makePatient();
    await expect(
      withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "platinum_verified", "X")),
    ).rejects.toMatchObject({ code: "invalid_assurance" });
  });

  it("allows a staff upgrade and records the new level", async () => {
    const id = await makePatient();
    const out = await withTx(db, (tx) => upgradeAssurance(tx, CLERK, id, "id_verified", "AADHAAR-XXXX-1234"));
    expect(out).toEqual({ from: "staff_verified", to: "id_verified" });
  });
});

describe("A10 — versions are append-only", () => {
  it("the database refuses an UPDATE of a version row", async () => {
    const id = await makePatient();
    await expect(
      db.update(patientIdentityVersions).set({ name: "Rewritten" }).where(eq(patientIdentityVersions.patientId, id)),
    ).rejects.toThrow(/patient_identity_immutable/);
  });
});

describe("the resolver (T6, DD6) — as-of, on a fixture", () => {
  /**
   * `issuedAt` is derived from v2 AFTER the amendment, never as "v1 + a second". The first run of
   * this file did the latter and three of these tests failed — correctly. Registration and
   * amendment land milliseconds apart in a test, so `v1.validFrom + 1000ms` is AFTER v2 and the
   * resolver rightly returned the new name. The fixture was wrong, not the resolver; anchoring to
   * v2 makes the instant deterministic regardless of how fast the suite runs.
   */
  async function justBefore(patientId: string, version: number): Promise<Date> {
    const rows = await db.select().from(patientIdentityVersions)
      .where(eq(patientIdentityVersions.patientId, patientId));
    const v = rows.find((r) => r.version === version)!;
    return new Date(v.validFrom.getTime() - 1);
  }

  it("A19 — returns the version in force at t, not the current row", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { name: "Asha Sharma" }, { reasonClass: "legal_change" }));
    const issuedAt = await justBefore(id, 2);

    const asOf = await resolveIdentityAt(db, id, issuedAt);
    expect(asOf!.name).toBe("Asha Devi");
    // …and the live row really did change, so the assertion above is about the resolver rather
    // than about nothing having happened.
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.name).toBe("Asha Sharma");
  });

  it("A20 — with no version at or before t, returns the EARLIEST version", async () => {
    const id = await makePatient();
    const [v1] = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    const beforeAnything = new Date(v1!.validFrom.getTime() - 86_400_000);
    const asOf = await resolveIdentityAt(db, id, beforeAnything);
    // Returning null instead would make every pre-0043 document fail to render, which is a worse
    // answer than "the oldest state we know about".
    expect(asOf).not.toBeNull();
    expect(asOf!.version).toBe(1);
  });

  it("A21 — a version minted at exactly t IS in force at t", async () => {
    const id = await makePatient();
    await withTx(db, (tx) => updatePatient(tx, CLERK, id, { name: "Asha Sharma" }, { reasonClass: "legal_change" }));
    const rows = await db.select().from(patientIdentityVersions).where(eq(patientIdentityVersions.patientId, id));
    const v2 = rows.find((r) => r.version === 2)!;
    // `<` instead of `<=` would resolve this to v1 — an amendment and an issue in the same second
    // rendering the wrong side, decided by clock luck.
    const asOf = await resolveIdentityAt(db, id, v2.validFrom);
    expect(asOf!.version).toBe(2);
    expect(asOf!.name).toBe("Asha Sharma");
  });

  it("A22 — the whole Class I set moves together, from one version row", async () => {
    const id = await makePatient();
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { name: "Asha Sharma", administrativeGender: "other" },
        { reasonClass: "legal_change" }));
    const asOf = await resolveIdentityAt(db, id, await justBefore(id, 2));
    // Resolving each field independently against "the newest version that touched it" would mix
    // an old name with a new gender on one document.
    expect(asOf).toMatchObject({ name: "Asha Devi", administrativeGender: "female", version: 1 });
  });

  it("A23 — dob comes from the version, so age is computable as-of-encounter", async () => {
    const id = await makePatient();
    await withTx(db, (tx) =>
      updatePatient(tx, CLERK, id, { dob: new Date(Date.UTC(1990, 0, 1)) }, { reasonClass: "clerical_error" }));
    const asOf = await resolveIdentityAt(db, id, await justBefore(id, 2));
    expect(asOf!.dob!.getTime()).not.toBe(Date.UTC(1990, 0, 1));
  });

  it("returns null for a patient with no versions at all", async () => {
    expect(await resolveIdentityAt(db, "no-such-patient", new Date())).toBeNull();
  });
});
