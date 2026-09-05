import { displayName, displayNameForRelease } from "./display-name";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { useBreakGlass } from "../../kernel/auth/break-glass";
import { breakGlassGrants } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patientsManifest } from "./manifest";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T8 / F20 — the rule §14 always had and never had in ONE place.
 *
 * The behavioural half (that the OT's list and recovery board actually route through this) lives in
 * `modules/ot/lists.test.ts` and `modules/ot/recovery.test.ts`, because a helper that is correct and
 * uncalled protects nobody — which is the failure mode this whole helper exists to end.
 */
describe("displayName (§14 / F20)", () => {
  const ordinary = { name: "Sunita Devi", alias: null, isConfidential: false };
  const vip = { name: "Ravi Shankar Menon", alias: "Patient A", isConfidential: true };

  it("an ordinary patient is their name, to everybody", () => {
    expect(displayName(ordinary, false)).toBe("Sunita Devi");
    expect(displayName(ordinary, true)).toBe("Sunita Devi");
  });

  it("a confidential patient is their ALIAS without the permission, and their name with it", () => {
    expect(displayName(vip, false)).toBe("Patient A");
    expect(displayName(vip, true)).toBe("Ravi Shankar Menon");
  });

  /**
   * Registration refuses to flag a patient confidential without an alias (`alias_required`), so
   * this row cannot be created through the front door. It can exist from a repair script or a row
   * written before that constraint — and the safe direction is not arguable: the one row that
   * slipped past the constraint must not be the one row that leaks a name.
   */
  it("a confidential patient with NO alias is a dash — never the legal name", () => {
    const unaliased = { name: "Ravi Shankar Menon", alias: null, isConfidential: true };
    expect(displayName(unaliased, false)).toBe("—");
    expect(displayName(unaliased, false)).not.toContain("Ravi");
  });

  /**
   * An empty-string alias is falsy in JavaScript but is NOT null, so `??` keeps it — and an empty
   * cell on a theatre list is indistinguishable from a rendering bug. This asserts the current
   * behaviour rather than asserting a dash, because the fix belongs at registration (which already
   * refuses a blank alias) and a second normalisation here would be the second copy of the rule
   * this helper exists to remove. Recorded so the next reader knows it was considered.
   */
  it("an empty alias is passed through as empty — registration is where blank aliases are refused", () => {
    expect(displayName({ name: "Ravi", alias: "", isConfidential: true }, false)).toBe("");
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 / OWNER RULING 2026-09-05 — `displayNameForRelease`, THE SECOND CLAUSE OF THE SAME RULE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * *"Alias by default; the LEGAL NAME prints only when the operator goes through the existing
 * break-glass grant, which is already logged."* The rows above pin the default. These pin the road,
 * and they are DB-backed because both halves of the question are rows: `hasPermission` walks role
 * assignments, and `hasActiveBreakGlass` walks `break_glass_grants` with a live expiry comparison.
 * A fake for either would be a second implementation of the thing under test.
 *
 * The SURFACE proof — that the printer actually asks this, and that paper changes — is in
 * `kernel/printing/render.test.ts`. A helper that is correct and uncalled protects nobody, which is
 * the failure mode the whole file exists to end.
 */
describe("displayNameForRelease (§14 / FD-25 — permission OR break-glass)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let registry: ModuleRegistry;

  const VIP = { name: "Ravi Shankar Menon", alias: "Patient A", isConfidential: true };
  const OTHER_VIP = { name: "Farida Khatoon", alias: "Patient B", isConfidential: true };
  const ORDINARY = { name: "Sunita Devi", alias: null, isConfidential: false };
  /* Two patient IDs. They need not exist as rows — `break_glass_grants.patient_id` carries no
     foreign key, and the rule takes the name as a value, so what is under test here is the
     SCOPE COMPARISON and nothing else. */
  const P_A = newId();
  const P_B = newId();

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    registry = new ModuleRegistry();
    registry.install(patientsManifest);
  });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
  });

  /** A clerk with no clearance of any kind — the state 99% of the front desk is in. */
  async function plainClerk(username = "release-clerk"): Promise<Actor> {
    return (await mkUser(db, username, ["front_office"])).actor;
  }

  /**
   * The standing grant. `patients.confidential.read` is held by ZERO seeded roles by design, so a
   * holder is minted the way `registration.test.ts` does: a role that exists for this question.
   */
  async function permissionHolder(username = "vip-desk-reader"): Promise<Actor> {
    const holder = await mkUser(db, username, ["vip_desk"]); // `ensureRole` mints the role row
    await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
    return holder.actor;
  }

  /** THE NEGATIVE CONTROL, and it must not move: no permission, no grant, still the alias. */
  it("is the ALIAS for an operator with neither the permission nor a grant", async () => {
    const clerk = await plainClerk();
    expect(await displayNameForRelease(db, clerk, VIP, P_A)).toBe("Patient A");
  });

  /** The first clause, unchanged: the standing permission is still a road, and still the only one on screens. */
  it("is the LEGAL name for a holder of patients.confidential.read, with no grant anywhere", async () => {
    const holder = await permissionHolder();
    expect(await displayNameForRelease(db, holder, VIP, P_A)).toBe("Ravi Shankar Menon");
  });

  /**
   * ═══ THE ROW THE OWNER RULED ON ═══
   *
   * The same clerk, one grant apart. `getPatient` opens the sealed record for this operator and
   * hands them the legal name on screen; before FD-25 this function's sibling handed them "Patient
   * A" on paper, and the two answers were both live at once.
   */
  it("is the LEGAL name for an operator who came through BREAK-GLASS, without the permission", async () => {
    const clerk = await plainClerk();
    expect(await displayNameForRelease(db, clerk, VIP, P_A)).toBe("Patient A");

    await useBreakGlass(db, testCfg, clerk, { patientId: P_A, reason: "unconscious, 2 a.m." });
    expect(await displayNameForRelease(db, clerk, VIP, P_A)).toBe("Ravi Shankar Menon");
  });

  /** THE KEY FITS ONE LOCK — the property that makes a per-patient grant different from a permission. */
  it("a grant for patient A does NOT unseal patient B", async () => {
    const clerk = await plainClerk();
    await useBreakGlass(db, testCfg, clerk, { patientId: P_A, reason: "unconscious, 2 a.m." });

    expect(await displayNameForRelease(db, clerk, VIP, P_A)).toBe("Ravi Shankar Menon");
    expect(await displayNameForRelease(db, clerk, OTHER_VIP, P_B)).toBe("Patient B");
  });

  /**
   * A HOSPITAL-WIDE grant IS allowed, and deliberately: it is the shape a mass-casualty night
   * takes, where the person needing the record cannot name the patient id first. `getPatient`
   * already honours it; paper that refused it would send a clinician back to a screen to read the
   * name off and copy it by hand.
   */
  it("a hospital-wide grant opens any sealed name — the shape a night emergency actually takes", async () => {
    const clerk = await plainClerk();
    await useBreakGlass(db, testCfg, clerk, { reason: "mass casualty, ids unknown" });
    expect(await displayNameForRelease(db, clerk, VIP, P_A)).toBe("Ravi Shankar Menon");
    expect(await displayNameForRelease(db, clerk, OTHER_VIP, P_B)).toBe("Farida Khatoon");
  });

  /** A LAPSED GRANT IS NOT A GRANT. Expiry is enforced in the read, so it stops at the instant it lapses. */
  it("an EXPIRED grant is the alias", async () => {
    const clerk = await plainClerk();
    await db.insert(breakGlassGrants).values({
      id: newId(), userId: clerk.id, patientId: P_A, reason: "yesterday's emergency",
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await displayNameForRelease(db, clerk, VIP, P_A)).toBe("Patient A");
  });

  /**
   * A GRANT BELONGS TO A HUMAN, NOT TO AN ID. `break_glass_grants.user_id` is plain text with no
   * foreign key and the print relay presents an AGENT credential; checking the id before the actor
   * TYPE would let a machine inherit a person's justification on the one path with no human to be
   * reviewed for it. The `system` actor is the same case wearing the other uniform.
   */
  it("an agent or system actor carrying a grant-holder's id still gets the alias", async () => {
    const clerk = await plainClerk();
    await useBreakGlass(db, testCfg, clerk, { patientId: P_A, reason: "unconscious, 2 a.m." });
    for (const type of ["agent", "system"] as const) {
      expect(await displayNameForRelease(db, { type, id: clerk.id }, VIP, P_A)).toBe("Patient A");
    }
  });

  /** The dash survives the wider road: a sealed row with no alias shows nothing, never the legal name. */
  it("a sealed patient with NO alias is still a dash for an operator without either road", async () => {
    const clerk = await plainClerk();
    const unaliased = { name: "Ravi Shankar Menon", alias: null, isConfidential: true };
    const shown = await displayNameForRelease(db, clerk, unaliased, P_A);
    expect(shown).toBe("—");
    expect(shown).not.toContain("Ravi");
  });

  /**
   * THE REGRESSION TO FEAR: an ordinary patient is their name to EVERYBODY, and this function must
   * not have quietly become a second gate on the 99.9% of people who were never sealed.
   */
  it("leaves an ORDINARY patient untouched for every kind of requester", async () => {
    const clerk = await plainClerk();
    const holder = await permissionHolder();
    await useBreakGlass(db, testCfg, clerk, { patientId: P_A, reason: "unconscious" });
    const requesters: Actor[] = [clerk, holder, { type: "agent", id: "relay-1" }, { type: "system", id: "worker" }];
    for (const requester of requesters) {
      expect(await displayNameForRelease(db, requester, ORDINARY, P_A)).toBe("Sunita Devi");
    }
  });
});
