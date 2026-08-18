import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedSodPairs } from "../../kernel/auth/sod";
import { getApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import { BILLING_APPROVAL_TYPES, registerBillingApprovalTypes } from "./approval-types";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

const ACTIVATOR: Actor = { type: "user", id: "billing-approval-activator" };

describe("approval-types: registerBillingApprovalTypes", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
  });

  test("registers the five billing approval types: billing_manager approver, matching urgency classes, actFirstAllowed false", async () => {
    expect(BILLING_APPROVAL_TYPES.map((s) => s.typeKey)).toEqual([
      "billing_credit_extension", "billing_discount", "billing_clearance_discount", "billing_refund", "billing_variance",
    ]);
    await registerBillingApprovalTypes(db, ACTIVATOR);
    for (const spec of BILLING_APPROVAL_TYPES) {
      const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
      expect(row).not.toBeNull();
      expect(row!.approverRole).toBe("billing_manager");
      expect(row!.urgencyClass).toBe(spec.urgencyClass);
      expect(row!.actFirstAllowed).toBe(false);
    }
  });

  test("idempotent on a second call: no throw, all five still registered, exactly once each", async () => {
    await registerBillingApprovalTypes(db, ACTIVATOR);
    await expect(registerBillingApprovalTypes(db, ACTIVATOR)).resolves.toBeUndefined();
    for (const spec of BILLING_APPROVAL_TYPES) {
      const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
      expect(row).not.toBeNull();
      expect(row!.typeKey).toBe(spec.typeKey);
    }
  });
});
