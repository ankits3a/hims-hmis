import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedSodPairs } from "../../kernel/auth/sod";
import { getApprovalType } from "../../kernel/approvals/types";
import { approvalTypes, workflowDefinitions } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { MEMBERSHIP_APPROVAL_TYPES, registerMembershipApprovalTypes } from "./approval-types";
import { GRACE_HONOR_APPROVAL_TYPE } from "./recognition";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

const ACTIVATOR: Actor = { type: "user", id: "membership-approval-activator" };

/**
 * PLAN 09 T3 / §6.0 S3 — the registration `scripts/seed-membership.ts` carries into a deployment.
 *
 * The IDEMPOTENCE leg is the one with teeth: `docker/prod/deploy.sh` runs this seed on EVERY
 * deploy (S14), so a second call that drafted another workflow-definition version, or reached
 * `registerApprovalType`'s `duplicate_type` throw, would stop a deploy dead under
 * `set -euo pipefail` — after the migrations had applied and before the containers were recreated.
 */
describe("approval-types: registerMembershipApprovalTypes", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
  });

  it("registers O-1's ONE type: billing_manager approver, urgent, actFirstAllowed FALSE", async () => {
    expect(MEMBERSHIP_APPROVAL_TYPES.map((s) => s.typeKey)).toEqual([GRACE_HONOR_APPROVAL_TYPE]);
    await registerMembershipApprovalTypes(db, ACTIVATOR);

    const row = await withTx(db, (tx) => getApprovalType(tx, GRACE_HONOR_APPROVAL_TYPE));
    expect(row).not.toBeNull();
    expect(row!.approverRole).toBe("billing_manager");
    expect(row!.urgencyClass).toBe("urgent");
    // O-1 in as many words: the value of the approval is that grace-honouring is rare and
    // reviewed. Act-first would make it the default answer at a busy counter.
    expect(row!.actFirstAllowed).toBe(false);
  });

  it("is IDEMPOTENT: a second run neither throws, nor re-registers, nor drafts a second version", async () => {
    await registerMembershipApprovalTypes(db, ACTIVATOR);
    const afterFirst = await db.select().from(workflowDefinitions);

    await expect(registerMembershipApprovalTypes(db, ACTIVATOR)).resolves.toBeUndefined();

    expect(await db.select().from(approvalTypes)).toHaveLength(1);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(afterFirst.length);
  });
});
