import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createDraft, approveDefinition, activateDefinition, GovernanceError } from "./definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs, SodViolationError } from "../auth/sod";
import { workflowDefinitions, events } from "../db/schema";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DEF_A = {
  key: "class_a_flow",
  title: "Class A Flow",
  changeClass: "A",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "record_only" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};
const DEF_C = { ...DEF_A, key: "class_c_flow", title: "Class C Flow", changeClass: "C" };
const DEF_B = { ...DEF_A, key: "class_b_flow", title: "Class B Flow", changeClass: "B" };

describe("workflow governance", () => {
  let db: Db; let teardown: () => Promise<void>;
  let drafter: Actor; let owner: Actor; let ms: Actor; let dm: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    drafter = await mk("drafter"); owner = await mk("owner1"); ms = await mk("ms1"); dm = await mk("dm1");
    await createRole(db, "owner", "Owner");
    await createRole(db, "medical_superintendent", "Medical Superintendent");
    await createRole(db, "duty_manager", "Duty Manager");
    await assignRole(db, { userId: owner.id, roleKey: "owner", scopeType: "hospital" });
    await assignRole(db, { userId: ms.id, roleKey: "medical_superintendent", scopeType: "hospital" });
    await assignRole(db, { userId: dm.id, roleKey: "duty_manager", scopeType: "hospital" });
  });

  it("class C activates with zero approvals and retires the previous active version", async () => {
    const v1 = await createDraft(db, drafter, DEF_C);
    const first = await activateDefinition(db, owner, v1.definitionId);
    expect(first.retiredVersion).toBeNull();
    const v2 = await createDraft(db, drafter, DEF_C);
    const second = await activateDefinition(db, owner, v2.definitionId);
    expect(second.retiredVersion).toBe(1);
    const rows = await db.select().from(workflowDefinitions);
    expect(rows.find((r) => r.version === 1)!.status).toBe("retired");
    expect(rows.find((r) => r.version === 2)!.status).toBe("active");
    expect(rows.find((r) => r.version === 2)!.activatedBy).toBe(owner.id);
  });

  it("blocks the drafter from activating their own definition (SoD) and events the block", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_C);
    await expect(activateDefinition(db, drafter, definitionId)).rejects.toThrow(SodViolationError);
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked).toHaveLength(1);
    const row = await db.select().from(workflowDefinitions);
    expect(row[0]!.status).toBe("draft"); // activation rolled back; the block event survived
  });

  it("class A refuses activation until owner AND medical_superintendent both approve", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "reviewed" });
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
    await approveDefinition(db, ms, { definitionId, roleKey: "medical_superintendent", note: "reviewed" });
    const { retiredVersion } = await activateDefinition(db, owner, definitionId);
    expect(retiredVersion).toBeNull();
    const emitted = await db.select().from(events).where(eq(events.name, "workflow.definition.updated"));
    // drafted + 2×approved + activated
    expect(emitted).toHaveLength(4);
  });

  // Class B coverage (D-15): department_head + duty_manager, and no emergency set at all.
  // The department_head role/holder is created here so the shared beforeEach stays as written.
  it("class B requires department_head AND duty_manager approvals and has no emergency set", async () => {
    const { id: dhId } = await createUser(db, { username: "dh1", fullName: "dh1", password: "p1234567" });
    const dh: Actor = { type: "user", id: dhId };
    await createRole(db, "department_head", "Department Head");
    await assignRole(db, { userId: dhId, roleKey: "department_head", scopeType: "hospital" });
    const { definitionId } = await createDraft(db, drafter, DEF_B);
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
    await expect(
      approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "no emergency for B", emergency: true }),
    ).rejects.toMatchObject({ code: "role_not_in_policy" });
    await approveDefinition(db, dh, { definitionId, roleKey: "department_head", note: "reviewed" });
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
    await approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "reviewed" });
    const { retiredVersion } = await activateDefinition(db, owner, definitionId);
    expect(retiredVersion).toBeNull();
    const rows = await db.select().from(workflowDefinitions);
    expect(rows[0]!.status).toBe("active");
  });

  it("rejects approvals from users who do not hold the role, or roles outside the class policy", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await expect(
      approveDefinition(db, dm, { definitionId, roleKey: "owner", note: "not mine" }),
    ).rejects.toMatchObject({ code: "approver_lacks_role" });
    await expect(
      approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "wrong class role" }),
    ).rejects.toMatchObject({ code: "role_not_in_policy" });
    await expect(
      approveDefinition(db, { type: "agent", id: "a1" }, { definitionId, roleKey: "owner", note: "no" }),
    ).rejects.toMatchObject({ code: "actor_not_user" });
  });

  it("rejects a second approval by the same user", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "one" });
    await expect(
      approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "two" }),
    ).rejects.toMatchObject({ code: "duplicate_approval" });
  });

  it("emergency path: duty_manager + MS emergency approvals activate AND supersede the drafter SoD (E-5)", async () => {
    const { definitionId } = await createDraft(db, ms, DEF_A); // the MS drafted it themselves
    await approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "owner unreachable", emergency: true });
    await approveDefinition(db, ms, { definitionId, roleKey: "medical_superintendent", note: "owner unreachable", emergency: true });
    // drafter (ms) activates: allowed, because activation proceeds on the emergency set (declared precedence)
    const { retiredVersion } = await activateDefinition(db, ms, definitionId);
    expect(retiredVersion).toBeNull();
    const emitted = await db.select().from(events).where(eq(events.name, "workflow.definition.updated"));
    const activated = emitted.map((e) => e.payload as { action: string; emergency?: boolean }).find((p) => p.action === "activated");
    expect(activated!.emergency).toBe(true);
  });

  it("normal-path approvals do not satisfy the emergency set and vice versa", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_A);
    await approveDefinition(db, dm, { definitionId, roleKey: "duty_manager", note: "e", emergency: true });
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "n" });
    // one emergency (dm) + one normal (owner): neither set is complete
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({
      code: "approvals_missing",
    });
  });

  it("refuses approval and activation on non-draft definitions", async () => {
    const { definitionId } = await createDraft(db, drafter, DEF_C);
    await activateDefinition(db, owner, definitionId);
    await expect(
      approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "late" }),
    ).rejects.toMatchObject({ code: "not_draft" });
    await expect(activateDefinition(db, owner, definitionId)).rejects.toMatchObject({ code: "not_draft" });
  });
});
