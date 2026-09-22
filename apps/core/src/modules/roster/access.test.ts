import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { permissions, roleAssignments, rolePermissions, roles, users } from "../../kernel/db/schema";
import { requireRosterAct } from "./access";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ } from "./policy";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PHASE R (R1) — **the S1 fix arriving in access control**, executed against a real permission read.
 *
 * Plan 20 T1 asked `hasPermission(..., "hospital")` for every act, which means the senior resident
 * who may publish Orthopaedics' October may publish Medicine's. Every act that names a department
 * is now checked AT that department, and the test that matters is the CROSS one: a holder scoped to
 * Orthopaedics, refused for Medicine. A suite that only ever asks about the department somebody
 * holds cannot tell a scoped check from an unscoped one.
 */
describe("roster — the grant, at the department (R1)", () => {
  const MS = "01USER00000000000000000MS";
  const SR = "01USER00000000000000000SR";
  const ORTHO = "01ORGDEPT000000000000ORT";
  const MEDICINE = "01ORGDEPT000000000000MED";
  const user = (id: string): Actor => ({ type: "user", id });

  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(roles).values([
      { key: "medical_superintendent", title: "Medical Superintendent" },
      { key: "unit_sr", title: "Unit senior resident" },
    ]);
    await db.insert(permissions).values(
      [ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ].map((permission) => ({ permission, module: "roster" })),
    );
    await db.insert(rolePermissions).values([
      { roleKey: "medical_superintendent", permission: ROSTER_MANAGE },
      { roleKey: "medical_superintendent", permission: ROSTER_PUBLISH },
      { roleKey: "medical_superintendent", permission: ROSTER_READ },
      { roleKey: "unit_sr", permission: ROSTER_MANAGE },
      { roleKey: "unit_sr", permission: ROSTER_READ },
    ]);
    for (const [id, username] of [[MS, "sunita.mishra"], [SR, "kavita.rao"]] as const) {
      await db.insert(users).values({
        id, username, fullName: username, staffCode: `EMP-${id.slice(-4)}`, passwordHash: "x",
      });
    }
    // The MS holds at HOSPITAL scope; the senior resident holds inside Orthopaedics and nowhere else.
    await db.insert(roleAssignments).values([
      { id: "RA-MS", userId: MS, roleKey: "medical_superintendent", scopeType: "hospital", scopeId: null },
      { id: "RA-SR", userId: SR, roleKey: "unit_sr", scopeType: "department", scopeId: ORTHO },
    ]);
  });

  const refusal = async (p: Promise<unknown>): Promise<RosterError> => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(RosterError);
    return e as RosterError;
  };

  /* ═══════════════════ the cross-department leg ═══════════════════ */

  it("a department-scoped holder may act in THEIR department", async () => {
    await expect(requireRosterAct(db, user(SR), "propose", { departmentId: ORTHO })).resolves.toBeUndefined();
  });

  it("…and is REFUSED in another department, with the permission and the department named", async () => {
    const e = await refusal(requireRosterAct(db, user(SR), "propose", { departmentId: MEDICINE }));
    expect(e.code).toBe("not_permitted");
    expect(e.detail).toEqual({ permission: ROSTER_MANAGE, act: "propose", departmentId: MEDICINE });
  });

  it("…and is REFUSED for an act that names NO department — the hospital's own list is not theirs", async () => {
    // The asymmetry is the point: a HOSPITAL-scoped holding satisfies a department check, and a
    // department-scoped one does not satisfy a hospital check. Without this leg the scoping is
    // decorative — everything would pass by being asked the easier question.
    const e = await refusal(requireRosterAct(db, user(SR), "propose"));
    expect(e.code).toBe("not_permitted");
    expect(e.detail).toEqual({ permission: ROSTER_MANAGE, act: "propose", departmentId: null });
  });

  it("a HOSPITAL-scoped holder covers every department, with no second 'fallback' call to do it", async () => {
    for (const departmentId of [ORTHO, MEDICINE]) {
      await expect(requireRosterAct(db, user(MS), "publish", { departmentId })).resolves.toBeUndefined();
    }
    await expect(requireRosterAct(db, user(MS), "publish")).resolves.toBeUndefined();
  });

  /* ═══════════════════ the two 403s are different answers ═══════════════════ */

  it("the person who holds nothing is told they lack the GRANT", async () => {
    const e = await refusal(requireRosterAct(db, user(SR), "publish", { departmentId: ORTHO }));
    expect(e.code).toBe("not_permitted");
    expect(e.detail).toMatchObject({ permission: ROSTER_PUBLISH });
  });

  it("the machine that asks to publish is told it is the WRONG KIND OF THING — before any grant is read", async () => {
    // And it is told so even where the actor id happens to be a user who DOES hold the grant:
    // the policy runs first, so a system job cannot inherit a human's authority by borrowing an id.
    const e = await refusal(requireRosterAct(db, { type: "system", id: MS }, "publish", { departmentId: ORTHO }));
    expect(e.code).toBe("act_not_available_to_actor");
  });

  it("the user's copilot is refused the same act the user is allowed", async () => {
    await expect(requireRosterAct(db, user(MS), "publish", { departmentId: ORTHO }, "direct")).resolves.toBeUndefined();
    const e = await refusal(requireRosterAct(db, user(MS), "publish", { departmentId: ORTHO }, "copilot"));
    expect(e.code).toBe("act_not_available_to_actor");
  });

  it("a named system job reads without holding anything — and still cannot publish", async () => {
    await expect(requireRosterAct(db, { type: "system", id: "roster-proposer" }, "read")).resolves.toBeUndefined();
    const e = await refusal(requireRosterAct(db, { type: "system", id: "roster-proposer" }, "publish"));
    expect(e.code).toBe("act_not_available_to_actor");
  });

  it("an AGENT may read only if something granted it the string — and nothing has", async () => {
    // The matrix says an agent's read is "yes, SCOPED". Agent grants are `kernel/auth`'s and are out
    // of this plan (§7), so today the read is permitted by the policy and refused by the grant —
    // which is the correct pair of answers, and a different pair from `never`.
    const e = await refusal(requireRosterAct(db, { type: "agent", id: "AG-1" }, "read"));
    expect(e.code).toBe("not_permitted");
  });
});
