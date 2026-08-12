import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { registerApprovalType, getApprovalType, ApprovalError } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { seedSodPairs } from "../auth/sod";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };

describe("approval type registry", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const { id } = await createUser(db, { username: "activator1", fullName: "A", password: "p1234567" });
    activator = { type: "user", id };
  });

  async function activateFlow(typeKey: string, approverRole: string): Promise<void> {
    const def = approvalFlowDefinition({
      typeKey, title: `Flow ${typeKey}`, approverRole, closureSlaMinutes: 45,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
  }

  it("registers a type against its active definition and reads it back", async () => {
    await activateFlow("discount_override", "billing_head");
    const result = await registerApprovalType(db, activator, {
      typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head",
    });
    expect(result).toEqual({ typeKey: "discount_override", defKey: "approval_discount_override" });
    await withTx(db, async (tx) => {
      const row = await getApprovalType(tx, "discount_override");
      expect(row).toMatchObject({
        typeKey: "discount_override",
        defKey: "approval_discount_override",
        approverRole: "billing_head",
        urgencyClass: "routine",
        actFirstAllowed: false,
        createdBy: activator.id,
      });
      expect(await getApprovalType(tx, "missing")).toBeNull();
    });
  });

  it("stores the E-15 fields when given", async () => {
    await activateFlow("icu_admission", "duty_doctor");
    await registerApprovalType(db, activator, {
      typeKey: "icu_admission", title: "ICU Admission", approverRole: "duty_doctor",
      urgencyClass: "emergency", actFirstAllowed: true,
    });
    await withTx(db, async (tx) => {
      const row = await getApprovalType(tx, "icu_admission");
      expect(row).toMatchObject({ urgencyClass: "emergency", actFirstAllowed: true });
    });
  });

  it("refuses a type with no active definition", async () => {
    await expect(
      registerApprovalType(db, activator, {
        typeKey: "unbacked", title: "Unbacked", approverRole: "r",
      }),
    ).rejects.toMatchObject({ code: "definition_not_active" });
  });

  it("refuses a definition whose shape the engine does not depend on (E-18)", async () => {
    // A REAL Plan 03 definition, but not the approval shape: approverRole differs.
    await activateFlow("mismatch_role", "billing_head");
    await expect(
      registerApprovalType(db, activator, {
        typeKey: "mismatch_role", title: "Wrong Role", approverRole: "someone_else",
      }),
    ).rejects.toMatchObject({ code: "definition_mismatch" });
  });

  it("refuses a duplicate type without read-then-write", async () => {
    await activateFlow("dup_type", "billing_head");
    await registerApprovalType(db, activator, {
      typeKey: "dup_type", title: "Dup", approverRole: "billing_head",
    });
    await expect(
      registerApprovalType(db, activator, {
        typeKey: "dup_type", title: "Dup again", approverRole: "billing_head",
      }),
    ).rejects.toMatchObject({ code: "duplicate_type" });
  });

  it("refuses non-user actors", async () => {
    await expect(
      registerApprovalType(db, { type: "agent", id: "a1" }, {
        typeKey: "x", title: "X", approverRole: "r",
      }),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    expect(new ApprovalError("unknown_type").code).toBe("unknown_type");
  });
});
