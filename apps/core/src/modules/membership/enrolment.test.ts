import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { membershipInstances, membershipPlans, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { enrolMember, membershipSalesEnabled, requireSalesLane } from "./enrolment";
import { ROLE_MODEL, NOT_YET_MODELLED } from "../../../scripts/seed-roles";
import { membershipManifest } from "./manifest";
import type { Db } from "../../kernel/db/client";

/**
 * RC-2 T4 / D5 — ENROLLING A MEMBER IS NOT APPLYING ONE.
 *
 * The owner's ruling is that this is a PERMISSION, not a hidden button: "this seat applies
 * membership benefits and cannot enrol — enrolment is the front-office manager. Model it as two
 * permissions from day one."
 *
 * ═══ TWO GATES, AND EACH IS PROVEN SEPARATELY BECAUSE EITHER ALONE IS A FALSE COMFORT ═══
 *
 * A permission check passing while the lane is open would enrol somebody today. A closed lane
 * hiding a missing permission check would look correct until O-15 is ruled and the flag flips —
 * and the day a flag is flipped is the worst possible day to discover the authority underneath it
 * was never modelled. So the role model is asserted against the shipped `ROLE_MODEL` directly, and
 * the lane's refusal is asserted by execution.
 *
 * ═══ THE FLAG IS NEVER SET TO "true" IN THIS FILE ═══
 *
 * The state that ships is the variable being ABSENT, and a test that only ever writes "false"
 * never exercises it (`attribution.test.ts`'s G5 discipline). The armed path is proven by passing
 * an explicit env object rather than by arming the process, so no other suite can inherit it.
 */
const CLERK: Actor = { type: "user", id: "rc2-t4-clerk" };
const FLAG = "MEMBERSHIP_SALES_ENABLED";
const NOW = new Date("2026-09-01T06:00:00Z");

describe("RC-2 T4 — enrol is not apply (D5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });
  beforeEach(async () => {
    delete process.env[FLAG]; // the shipped state is ABSENT, not "false"
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  });

  // ── THE ROLE MODEL IS THE RULING ───────────────────────────────────────────────────────────

  it("front_office holds recognise (APPLY) and NOT enrol — the clerk who honours a card cannot mint one", () => {
    const holders = (perm: string) =>
      ROLE_MODEL.filter((r) => r.permissions.includes(perm)).map((r) => r.roleKey).sort();

    expect(holders("membership.instrument.recognise")).toContain("front_office");
    expect(holders("membership.instrument.enrol")).not.toContain("front_office");
    expect(holders("membership.instrument.enrol")).toEqual(["front_office_supervisor", "membership_admin"]);
  });

  it("the permission is DECLARED on the manifest, so the census counts it", () => {
    expect(membershipManifest.permissions).toContain("membership.instrument.enrol");
    // …and it is NOT parked: a parked permission is granted to nobody, which is the opposite ruling.
    expect(NOT_YET_MODELLED.map((n) => n.permission)).not.toContain("membership.instrument.enrol");
  });

  /**
   * THE DISTINCTION THIS TASK TURNS ON, asserted rather than left in a comment. `catalog.manage`
   * guards NO route and is granted to nobody; `enrol` guards a route that exists and is locked by a
   * flag, and IS granted. A key to a door that does not exist versus a lock.
   */
  it("membership.catalog.manage stays parked and ungranted — RC-2 built no catalog screen", () => {
    expect(NOT_YET_MODELLED.map((n) => n.permission)).toContain("membership.catalog.manage");
    const holders = ROLE_MODEL.filter((r) => r.permissions.includes("membership.catalog.manage"));
    expect(holders).toEqual([]);
  });

  // ── THE LANE IS STRUCTURALLY OFF (DD14 / owner ruling O-15 open) ────────────────────────────

  it("the flag ships ABSENT and reads false; requireSalesLane refuses with sales_disabled", () => {
    expect(membershipSalesEnabled({})).toBe(false);
    expect(() => requireSalesLane()).toThrow(expect.objectContaining({ code: "sales_disabled" }));
  });

  it.each([
    ["absent", {}, false],
    ['"false"', { [FLAG]: "false" }, false],
    ['"true"', { [FLAG]: "true" }, true],
    ['"1" (not the enum)', { [FLAG]: "1" }, "throws"],
    ['"TRUE" (not the enum)', { [FLAG]: "TRUE" }, "throws"],
    ['"" (not the enum)', { [FLAG]: "" }, "throws"],
  ])("reads %s exactly as kernel/config does — never a coercing boolean", (_l, env, expected) => {
    if (expected === "throws") {
      // The zod enum REFUSES a value it does not recognise rather than coercing it. Under a
      // coercing boolean, "false" is a non-empty string and therefore TRUE — which would arm
      // counter sales for an operator who wrote the value that means off.
      expect(() => membershipSalesEnabled(env as NodeJS.ProcessEnv)).toThrow();
    } else {
      expect(membershipSalesEnabled(env as NodeJS.ProcessEnv)).toBe(expected);
    }
  });

  it("enrolMember refuses before it reads anything, and writes NO instance", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Kavita Nair", sex: "female", ageYears: 47 }));
    const planId = newId();
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-T4-${planId.slice(-6)}`, title: "Invented Counter Plan", kind: "membership",
      benefits: [], entitlements: {}, validityDays: 365, createdBy: "test",
    });

    await expect(
      enrolMember(db, CLERK, { patientId: patient.id, planId, cardCode: "INV-T4-CARD-1", holderName: "Kavita Nair" }, NOW),
    ).rejects.toMatchObject({ code: "sales_disabled" });

    // The COUNT is the assertion, not the refusal: a lane that threw and wrote anyway would pass a
    // refusal-only test (attribution.test.ts's G5 shape).
    expect(await db.select().from(membershipInstances)).toHaveLength(0);
  });

  /**
   * THE ARMED PATH, proven so the refusal above is known to be the FLAG and not a broken function.
   * A gate that refuses because the code beneath it does not work is not a gate.
   *
   * DISCLOSED: this is the only case that runs the body, and it arms the flag on `process.env` for
   * exactly one call before deleting it, because `enrolMember` reads the live environment by
   * design (the `loadConfig`-in-CI reason its header gives).
   */
  it("with the lane armed it enrols onto the plan's validity window, origin `counter`, unverified", async () => {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, CLERK, { name: "Kavita Nair", sex: "female", ageYears: 47 }));
    const planId = newId();
    await db.insert(membershipPlans).values({
      id: planId, code: `INV-T4-${planId.slice(-6)}`, title: "Invented Counter Plan", kind: "membership",
      benefits: [], entitlements: {}, validityDays: 30, createdBy: "test",
    });

    process.env[FLAG] = "true";
    try {
      const out = await enrolMember(
        db, CLERK, { patientId: patient.id, planId, cardCode: " INV-T4-CARD-2 ", holderName: " Kavita Nair " }, NOW,
      );
      expect(out.cardCode).toBe("INV-T4-CARD-2"); // trimmed at the boundary
      expect(out.validTo).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));

      const rows = await db.select().from(membershipInstances).where(eq(membershipInstances.id, out.instanceId));
      expect(rows[0]).toMatchObject({
        planId, patientId: patient.id, status: "active",
        origin: "counter",  // not "import" (the book) and not "grace" (O-1) — provenance decides commission
        verified: false,    // C-17: an instance the holder book has not confirmed accrues nothing
      });
    } finally {
      delete process.env[FLAG];
    }
  });

  it("an unknown plan is refused once the lane is armed — the refusal order is flag first", async () => {
    process.env[FLAG] = "true";
    try {
      await expect(
        enrolMember(db, CLERK, { patientId: "p", planId: "no-such-plan", cardCode: "c", holderName: "h" }, NOW),
      ).rejects.toMatchObject({ code: "unknown_plan" });
    } finally {
      delete process.env[FLAG];
    }
  });
});
