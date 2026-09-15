import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { patients, phiAccessLog, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { createUser } from "../../kernel/auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { registerPatient } from "./registration";
import { LINKED_CAP, linkedPatients } from "./linked";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };

const FAMILY = "9041463343"; // the owner's own example, 2026-09-13
const OTHER = "9876543210";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-34 — TWO PATIENTS ON ONE MOBILE ARE A FAMILY, AND THE RECORD SAID NOTHING ABOUT IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-13: *"assume the patient Ankit has listed his phone number with us 9041463343.
 * Now, when another patient Sunil lists the same phone number … Ankit's details … must show Sunil
 * as a linked patient. In the same way Sunil profile should show Ankit as a linked family patient."*
 *
 * The shared mobile was already in this system THREE times over — the search lane finds it, the
 * duplicate probe warns on it, and the desk is told "same mobile" — and every one of those uses it
 * to warn a clerk that they may be about to create the WRONG record. Nobody ever used it to say the
 * true thing: in India one number is a household, and these are two people who belong together.
 *
 * THE LINK IS DERIVED, NEVER STORED. There is no household table (Plan 22c-B owns that, gated on
 * consent classes this phase has not built), and a stored edge would be a second authority on a
 * fact the `patients` row already carries — it would go stale the moment a number is corrected on
 * one side. Deriving it means the symmetry below is true BY CONSTRUCTION rather than by a
 * bookkeeping job that can be skipped.
 */
describe("linkedPatients — the family a shared mobile makes", () => {
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

  const register = async (
    name: string,
    extra: { phone?: string; altPhone?: string; isConfidential?: boolean; alias?: string } = {},
  ): Promise<{ id: string; uhid: string }> => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name, sex: "male", ...extra }),
    );
    return { id: patient.id, uhid: patient.uhid };
  };

  /**
   * THE OWNER'S SENTENCE, BOTH HALVES. Asserting only Ankit's page would pass against a
   * one-directional implementation — the shape a stored edge written at registration would have,
   * where whoever registered SECOND is linked and the first record never hears about it.
   */
  it("is symmetric: each patient's record names the other", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    const sunil = await register("Sunil Kumar", { phone: FAMILY });

    const forAnkit = await linkedPatients(db, clerk, ankit.id);
    expect(forAnkit.items.map((r) => r.id)).toEqual([sunil.id]);
    expect(forAnkit.items[0]).toMatchObject({ uhid: sunil.uhid, name: "Sunil Kumar", sharedOn: [FAMILY] });
    expect(forAnkit.total).toBe(1);

    const forSunil = await linkedPatients(db, clerk, sunil.id);
    expect(forSunil.items.map((r) => r.id)).toEqual([ankit.id]);
    expect(forSunil.items[0]).toMatchObject({ uhid: ankit.uhid, name: "Ankit Kumar", sharedOn: [FAMILY] });
  });

  /**
   * A SECOND NUMBER IS STILL THE FAMILY'S NUMBER. `alt_phone` exists because a household hands the
   * counter the husband's mobile on one visit and the son's on the next; matching only `phone`
   * would split that family in half and the half it dropped would be invisible.
   */
  it("matches across both of each side's numbers, and says which number it matched on", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    const mother = await register("Bimla Devi", { phone: OTHER, altPhone: FAMILY });

    const forAnkit = await linkedPatients(db, clerk, ankit.id);
    expect(forAnkit.items.map((r) => r.id)).toEqual([mother.id]);
    expect(forAnkit.items[0]!.sharedOn).toEqual([FAMILY]);

    // …and from the other side, where the shared number is the ALTERNATE one.
    const forMother = await linkedPatients(db, clerk, mother.id);
    expect(forMother.items.map((r) => r.id)).toEqual([ankit.id]);
    expect(forMother.items[0]!.sharedOn).toEqual([FAMILY]);
    expect(forMother.numbers).toEqual([OTHER, FAMILY]); // the numbers the link was computed from
  });

  it("never lists the patient themselves, and a phoneless record has no family", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    await register("Sunil Kumar", { phone: FAMILY });
    const walkIn = await register("No Number", {}); // D-34: phoneless patients are a designed path

    expect((await linkedPatients(db, clerk, ankit.id)).items.map((r) => r.id)).not.toContain(ankit.id);
    expect(await linkedPatients(db, clerk, walkIn.id)).toEqual({ numbers: [], items: [], total: 0 });
  });

  it("a different number is not a family", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    await register("Stranger Singh", { phone: OTHER });
    expect(await linkedPatients(db, clerk, ankit.id)).toMatchObject({ items: [], total: 0 });
  });

  /**
   * A MERGED RECORD IS NOT A SECOND PERSON. The merge chain is resolved on BOTH sides: a loser is
   * never listed as a family member (it is the same human as the winner, and showing both would
   * teach the desk that the family has one more person in it than it does), and a loser's id
   * ARRIVING as the subject resolves to the winner — the same rule `getPatient` applies, which is
   * why the subject goes through it rather than through a second lookup that could disagree.
   *
   * The merge is written directly here rather than driven through `createMergeRequest` /
   * `executeMerge`: those carry a separation-of-duties gate that is `merge.test.ts`'s subject, and
   * what this test needs is the STATE they leave behind.
   */
  it("resolves the merge chain on both sides", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    const sunil = await register("Sunil Kumar", { phone: FAMILY });
    const duplicate = await register("Sunil K", { phone: FAMILY });
    await db.update(patients)
      .set({ status: "merged", mergedIntoPatientId: sunil.id })
      .where(eq(patients.id, duplicate.id));

    const forAnkit = await linkedPatients(db, clerk, ankit.id);
    expect(forAnkit.items.map((r) => r.id)).toEqual([sunil.id]); // the loser is gone, not doubled

    // The subject given by the LOSER's id is the winner, so it must not list the winner as family.
    const viaLoser = await linkedPatients(db, clerk, duplicate.id);
    expect(viaLoser.items.map((r) => r.id)).toEqual([ankit.id]);
  });

  /**
   * §14 — THE SEAL HOLDS ON THIS SURFACE TOO, AND `total` DOES NOT LEAK EITHER.
   *
   * A family list is the easiest place in the system to defeat a confidentiality flag: the sealed
   * patient's own record refuses, and a link from their brother's record would hand over the name
   * anyway. Returning a COUNT that included them would be the same leak one step quieter — "three
   * people share this number, you may see two" tells the clerk exactly what the seal exists to
   * withhold.
   */
  it("hides a sealed family member — and does not count them either", async () => {
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_desk", "VIP Desk");
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    const holder = await createUser(db, { username: "holder-linked", fullName: "H", password: "p1234567" });
    await assignRole(db, { userId: holder.id, roleKey: "vip_desk", scopeType: "hospital" });

    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    const sealed = await register("Vip Person", { phone: FAMILY, isConfidential: true, alias: "Patient V" });

    const ordinary = await linkedPatients(db, clerk, ankit.id);
    expect(ordinary.items).toEqual([]);
    expect(ordinary.total).toBe(0);

    const privileged = await linkedPatients(db, { type: "user", id: holder.id }, ankit.id);
    expect(privileged.items.map((r) => r.id)).toEqual([sealed.id]);
    expect(privileged.items[0]!.isConfidential).toBe(true);
    expect(privileged.total).toBe(1);
  });

  /**
   * A SHOP'S NUMBER IS NOT A FAMILY. A clerk who types the hospital's own landline, a tout's mobile
   * or a village PCO number into fifty records makes a "family" of fifty, and rendering all of them
   * beside a patient's name is both useless and a disclosure. The cap bounds the render; `total` is
   * what tells the desk it is looking at a number that is not a household at all.
   */
  it("caps the list and still reports the true size", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    for (let i = 0; i < LINKED_CAP + 2; i += 1) await register(`Crowd ${String(i).padStart(2, "0")}`, { phone: FAMILY });

    const forAnkit = await linkedPatients(db, clerk, ankit.id);
    expect(forAnkit.items).toHaveLength(LINKED_CAP);
    expect(forAnkit.total).toBe(LINKED_CAP + 2);
  });

  /**
   * ONE ROW PER READ, AGAINST THE SUBJECT, ON ITS OWN SURFACE — `patient.coverage`'s reasoning
   * applied again: "a clerk opened a record" and "a clerk pulled this person's household off the
   * back of it" are different disclosures, and the reason is the only thing this log is ever asked
   * about. A read that found nobody writes nothing: a refusal is not a disclosure.
   */
  it("writes one patient.linked access row, and none when there is no family", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    const alone = await register("Solo Person", { phone: OTHER });

    await linkedPatients(db, clerk, alone.id);
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "patient.linked"))).toEqual([]);

    await register("Sunil Kumar", { phone: FAMILY });
    await linkedPatients(db, clerk, ankit.id);
    const rows = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "patient.linked"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: clerk.id, patientId: ankit.id, sealed: false });
  });

  /**
   * A DESK SURFACE, USER ACTORS ONLY. The patient app's own actor must NOT reach a household this
   * way: 22c-B's household model is consent-classed and silently revocable, and a derived link that
   * answered a patient actor would hand a logged-in phone owner every record on that number without
   * anybody consenting to it. `searchPatients` draws the same line for the same reason.
   */
  it("refuses a non-user actor", async () => {
    const ankit = await register("Ankit Kumar", { phone: FAMILY });
    await expect(linkedPatients(db, { type: "agent", id: "a1" }, ankit.id)).rejects.toMatchObject({
      code: "user_actor_required",
    });
    await expect(linkedPatients(db, { type: "patient", id: ankit.id }, ankit.id)).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
