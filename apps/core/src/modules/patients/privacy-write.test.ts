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
    // OWNER RULING 2026-09-29 — a death is recorded WITH its certificate number (the A-DC block
    // below pins that); this case is about who may write the field, so it carries one.
    await withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: "2026-08-29T10:00:00.000Z", deathCertificateNo: "MCCD/2026/0412" }));
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

/**
 * OWNER RULING 2026-09-29 (law) — "Record a death" must NOT save without the death certificate
 * number: for a death in this hospital, the MCCD certificate (Form 4 / 4A) number. The domain
 * function refuses it, so every caller (the PATCH route, and any later death cascade) is held to it.
 */
describe("A-DC — a death is recorded only with its certificate number", () => {
  const died = "2026-09-28T10:00:00.000Z";
  async function mrdAndPatient(): Promise<{ mrd: Actor; id: string }> {
    const mrd = await actorHolding(["patients.register", "patients.update", "patients.deceased.write"]);
    return { mrd, id: await makePatient(mrd) };
  }
  const row = async (id: string) => (await db.select().from(patients).where(eq(patients.id, id)))[0]!;

  it("REFUSES a date of death with no certificate number, in a plain sentence, and writes nothing", async () => {
    const { mrd, id } = await mrdAndPatient();
    await expect(withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: died })))
      .rejects.toMatchObject({ code: "death_certificate_required", message: expect.stringMatching(/death certificate number/) });
    expect((await row(id)).deceasedAt).toBeNull();
  });

  it("REFUSES a blank certificate number — spaces are not a number", async () => {
    const { mrd, id } = await mrdAndPatient();
    await expect(withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: died, deathCertificateNo: "   " })))
      .rejects.toMatchObject({ code: "death_certificate_required" });
    expect((await row(id)).deceasedAt).toBeNull();
  });

  it("SAVES the date and the number together, and diffs both into patient.updated", async () => {
    const { mrd, id } = await mrdAndPatient();
    const res = await withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: died, deathCertificateNo: " MCCD/2026/0412 " }));
    expect(res.changed.sort()).toEqual(["deathCertificateNo", "deceasedAt"]);
    const after = await row(id);
    expect(after.deceasedAt?.toISOString()).toBe(died);
    expect(after.deathCertificateNo).toBe("MCCD/2026/0412");
  });

  it("REFUSES taking the number off a record that stays deceased", async () => {
    const { mrd, id } = await mrdAndPatient();
    await withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: died, deathCertificateNo: "MCCD/2026/0412" }));
    await expect(withTx(db, (tx) => updatePatient(tx, mrd, id, { deathCertificateNo: null })))
      .rejects.toMatchObject({ code: "death_certificate_required" });
    expect((await row(id)).deathCertificateNo).toBe("MCCD/2026/0412");
  });

  it("clearing a mistaken death mark clears its number with it", async () => {
    const { mrd, id } = await mrdAndPatient();
    await withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: died, deathCertificateNo: "MCCD/2026/0412" }));
    const res = await withTx(db, (tx) => updatePatient(tx, mrd, id, { deceasedAt: null }));
    expect(res.changed.sort()).toEqual(["deathCertificateNo", "deceasedAt"]);
    const after = await row(id);
    expect(after.deceasedAt).toBeNull();
    expect(after.deathCertificateNo).toBeNull();
  });

  it("the number is behind the same wall as the date — a clerk cannot write it", async () => {
    const clerk = await actorHolding(["patients.register", "patients.update"]);
    const id = await makePatient(clerk);
    await expect(withTx(db, (tx) => updatePatient(tx, clerk, id, { deathCertificateNo: "MCCD/2026/0412" })))
      .rejects.toMatchObject({ code: "deceased_write_denied" });
  });
});

describe("A17 — the phase granted these to NOBODY; the OWNER granted them the next day", () => {
  /**
   * A17 AS WRITTEN ASSERTED THE OPPOSITE OF WHAT IS NOW TRUE, and it is restated rather than
   * deleted — ledger §2.135, learned in this phase's own second close review, where a reverted fix
   * left a test behind documenting the opposite of the ruling.
   *
   * The assertion A17 made was never "nobody may ever hold these". It was: **the phase that removes
   * a power from `patients.update` must not hand it straight back in the same commit** — because a
   * split that grants its own new string to a role already holding `patients.update` is cosmetic,
   * and that was A17's mutant (M-A17, which died). That claim is about the PHASE and it is still
   * exactly true: `04b7b21` granted nothing, and both strings sat unheld through the deploy.
   *
   * The owner ruled the day after, on the deployed system, and chose `mrd_officer`. That is a
   * separate act with its own commit, which is the whole point of DD7 routing it to a human.
   */
  /**
   * A TEST THAT ASSERTED THE PHASE'S HISTORY LIVED HERE FOR ONE COMMIT, AND CI DELETED IT.
   *
   * To keep A17's original claim alive after the owner's grant, I had this suite read the model
   * **as of commit `04b7b21`** with `git show` and assert the strings were absent. It passed here
   * and failed in CI, because `actions/checkout@v4` defaults to `fetch-depth: 1` — CI has the tip
   * commit and no history, so the command cannot resolve. My clone has full history, which is
   * exactly why the local run could not see the problem.
   *
   * The lesson is larger than the mechanism: **a historical fact does not belong in a test.** A
   * test asserts what must be true NOW and must stay true; "the commit that declared these granted
   * nothing" can never become false and can never be violated by future code, so nothing is
   * protected by checking it — while the check itself adds an environment dependency the build
   * does not otherwise have. That fact is recorded where facts belong: in `04b7b21`'s message, in
   * the ruling commit's message, and in the phase document's CLOSE §6.4 beside A17's dead mutant.
   *
   * What IS durable, and is asserted below and in A15/A16 above: `patients.update` alone still
   * cannot reach either field, and the holder set is exactly the one the owner named.
   */
  it("TODAY they are held by mrd_officer, and by mrd_officer alone", async () => {
    const holders = (p: string): string[] =>
      ROLE_MODEL.filter((r) => (r.permissions as readonly string[]).includes(p)).map((r) => r.roleKey);
    expect(holders("patients.confidential.write")).toEqual(["mrd_officer"]);
    expect(holders("patients.deceased.write")).toEqual(["mrd_officer"]);
  });

  it("the holder is the role that already holds patients.merge — the same authority over the same object", () => {
    const mrd = ROLE_MODEL.find((r) => r.roleKey === "mrd_officer")!;
    expect(mrd.permissions).toContain("patients.merge");
    expect(mrd.permissions).toContain("patients.confidential.write");
    // …and it did NOT pick up the read side, which is a different question nobody has ruled on.
    expect(mrd.permissions).not.toContain("patients.confidential.read");
  });

  it("both have LEFT the not-yet-modelled list, which is what that list is for", () => {
    const parked = NOT_YET_MODELLED.map((n) => n.permission);
    expect(parked).not.toContain("patients.confidential.write");
    expect(parked).not.toContain("patients.deceased.write");
    // `confidential.read` stays: SEEING a confidential record is still unruled.
    expect(parked).toContain("patients.confidential.read");
  });

  it("the manifest still declares them, so the catalogue row the grant references exists", () => {
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

  it("and at registration, unchanged — registration may still SET the flag (see m9)", async () => {
    // CLOSE REVIEW m9, ruled: `POST /patients` deliberately still accepts `isConfidential` under
    // `patients.register` alone. Marking a VIP confidential as part of taking the record is an
    // ordinary front-office act; DD7 governs changing an EXISTING patient's privacy flag. The
    // alias rule is what still binds here, and it binds unchanged.
    const privacy = await actorHolding(["patients.register"]);
    await expect(
      withTx(db, (tx) =>
        registerPatient(tx, privacy, { name: "VIP", sex: "male", ageYears: 40, isConfidential: true } as never)),
    ).rejects.toMatchObject({ code: "alias_required" });
  });
});
