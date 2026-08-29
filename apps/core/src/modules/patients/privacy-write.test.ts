import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import { patients, registrationConfig } from "../../kernel/db/schema";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { registerPatient, updatePatient } from "./registration";
import { NOT_YET_MODELLED, ROLE_MODEL } from "../../../scripts/seed-roles";

/**
 * PLAN 22c-A T5 — THE PRIVACY WRITE SPLIT (A15–A18, DD7).
 *
 * What this closes, measured in production on 2026-08-29 (spike S5): `patients.update` is held by
 * five roles and SEVENTEEN of thirty-five users, and it carries the power to set
 * `is_confidential`; `patients.confidential.read` is held by ZERO roles and ZERO users. Seventeen
 * people can hide a patient from every search surface in the hospital and nobody can read them
 * back. The permission that fixes a mistyped phone number is the permission that makes a person
 * disappear.
 */

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
afterAll(async () => teardown());
beforeEach(async () => {
  await truncateAll(db);
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "test" }).onConflictDoNothing();
});

function registry(): ModuleRegistry {
  const r = new ModuleRegistry();
  r.install(patientsManifest);
  return r;
}

/** A user holding EXACTLY the permissions named, at hospital scope (the search-provider pattern). */
async function actorHolding(permissions: string[]): Promise<Actor> {
  const reg = registry();
  await syncPermissions(db, reg);
  const suffix = Math.random().toString(36).slice(2, 9);
  const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
  if (permissions.length > 0) {
    const roleKey = `r${suffix}`;
    await createRole(db, roleKey, "Test role");
    for (const p of permissions) await grantPermissionToRole(db, reg, roleKey, p);
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
  }
  return { type: "user", id };
}

async function makePatient(actor: Actor, over: Record<string, unknown> = {}): Promise<string> {
  const { patient } = await withTx(db, (tx) =>
    registerPatient(tx, actor, { name: "Asha Devi", sex: "female", ageYears: 30, ...over } as never));
  return patient.id;
}

describe("A15 — patients.update alone cannot make a patient confidential", () => {
  it("REFUSES the clerk who can fix a typo", async () => {
    const clerk = await actorHolding(["patients.register", "patients.update"]);
    const id = await makePatient(clerk);
    await expect(
      withTx(db, (tx) => updatePatient(tx, clerk, id, { isConfidential: true, alias: "P-4821" })),
    ).rejects.toMatchObject({ code: "confidential_write_denied" });
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.isConfidential).toBe(false);
  });

  it("ALLOWS the holder of patients.confidential.write — the split discriminates, it does not just deny", async () => {
    // The positive control. Without it this file would pass against a build that refused everybody,
    // which is not the property being claimed.
    const privacy = await actorHolding(["patients.register", "patients.update", "patients.confidential.write"]);
    const id = await makePatient(privacy);
    await withTx(db, (tx) => updatePatient(tx, privacy, id, { isConfidential: true, alias: "P-4821" }));
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.isConfidential).toBe(true);
  });

  it("still lets that clerk do the ordinary job the permission is FOR", async () => {
    // The split must not cost the desk its day. A phone fix is untouched.
    const clerk = await actorHolding(["patients.register", "patients.update"]);
    const id = await makePatient(clerk);
    const { changed } = await withTx(db, (tx) => updatePatient(tx, clerk, id, { phone: "9000000000" }));
    expect(changed).toEqual(["phone"]);
  });

  it("REFUSES un-hiding as well as hiding — the gate is on the field, not on the direction", async () => {
    const privacy = await actorHolding(["patients.register", "patients.update", "patients.confidential.write"]);
    const id = await makePatient(privacy);
    await withTx(db, (tx) => updatePatient(tx, privacy, id, { isConfidential: true, alias: "P-4821" }));
    const clerk = await actorHolding(["patients.update"]);
    await expect(
      withTx(db, (tx) => updatePatient(tx, clerk, id, { isConfidential: false })),
    ).rejects.toMatchObject({ code: "confidential_write_denied" });
  });
});

describe("A16 — the same wall around deceasedAt", () => {
  it("REFUSES a clerk marking a patient dead", async () => {
    // `deceased_at` is a hard stop the notifications gateway reads at SEND time, ahead of urgency
    // and ahead of everything else in the suppression gauntlet. A clerk who can set it can
    // silence every message to a living patient's family.
    const clerk = await actorHolding(["patients.register", "patients.update"]);
    const id = await makePatient(clerk);
    await expect(
      withTx(db, (tx) => updatePatient(tx, clerk, id, { deceasedAt: "2026-08-29T10:00:00.000Z" })),
    ).rejects.toMatchObject({ code: "deceased_write_denied" });
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.deceasedAt).toBeNull();
  });

  it("ALLOWS the holder of patients.deceased.write", async () => {
    const mrd = await actorHolding(["patients.register", "patients.update", "patients.deceased.write"]);
    const id = await makePatient(mrd);
    await withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: "2026-08-29T10:00:00.000Z" }));
    expect((await db.select().from(patients).where(eq(patients.id, id)))[0]!.deceasedAt).not.toBeNull();
  });

  it("the two permissions are INDEPENDENT — holding one does not buy the other", async () => {
    const half = await actorHolding(["patients.register", "patients.update", "patients.confidential.write"]);
    const id = await makePatient(half);
    await expect(
      withTx(db, (tx) => updatePatient(tx, half, id, { deceasedAt: "2026-08-29T10:00:00.000Z" })),
    ).rejects.toMatchObject({ code: "deceased_write_denied" });
  });
});

describe("A17 — the phase grants the new permissions to NOBODY", () => {
  it("no role in ROLE_MODEL holds either string", () => {
    // If this ever fails, the split became cosmetic in the same commit that shipped it: the whole
    // point is that `patients.update` STOPS reaching these fields, and a grant to any role that
    // already holds `patients.update` restores exactly the state being removed.
    const granted = new Set(ROLE_MODEL.flatMap((r) => r.permissions));
    expect(granted.has("patients.confidential.write")).toBe(false);
    expect(granted.has("patients.deceased.write")).toBe(false);
  });

  it("both are named in NOT_YET_MODELLED with a reason, so 'held by nobody' is a decision on the record", () => {
    const parked = new Map(NOT_YET_MODELLED.map((n) => [n.permission, n.reason]));
    for (const p of ["patients.confidential.write", "patients.deceased.write"]) {
      expect(parked.has(p)).toBe(true);
      expect(parked.get(p)!.length).toBeGreaterThan(20);
    }
  });

  it("the manifest declares them, so the catalogue row exists for the owner's grant to reference", () => {
    expect(patientsManifest.permissions).toContain("patients.confidential.write");
    expect(patientsManifest.permissions).toContain("patients.deceased.write");
  });
});

describe("A18 — the shipped alias rule survives the split", () => {
  it("a confidential patient with no alias is still refused, by the holder of the new permission", async () => {
    // The split moved WHO may set the flag. It must not have moved WHETHER the flag is coherent:
    // a confidential patient with no alias renders a blank name on every public surface.
    const privacy = await actorHolding(["patients.register", "patients.update", "patients.confidential.write"]);
    const id = await makePatient(privacy);
    await expect(
      withTx(db, (tx) => updatePatient(tx, privacy, id, { isConfidential: true })),
    ).rejects.toMatchObject({ code: "alias_required" });
  });

  it("and at registration, unchanged", async () => {
    const privacy = await actorHolding(["patients.register"]);
    await expect(
      withTx(db, (tx) =>
        registerPatient(tx, privacy, { name: "VIP", sex: "male", ageYears: 40, isConfidential: true } as never)),
    ).rejects.toMatchObject({ code: "alias_required" });
  });
});
