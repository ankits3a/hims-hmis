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

  // GAP A3 (owner ruling 2026-09-28: credit is the owner's) — a sixth type, `billing_credit_owner`,
  // approved by the OWNER; the other five stay billing_manager.
  // OWNER RULINGS 2026-09-28 (money) — two more OWNER types: `billing_refund_owner` (a refund above
  // ₹25,000.00) and `billing_recon_charge_owner` (a bank short-settlement above ₹50.00 written off).
  const OWNER_TYPES = ["billing_credit_owner", "billing_refund_owner", "billing_recon_charge_owner"];
  test("registers the eight billing approval types: the three owner types by the owner, the rest billing_manager, matching urgency classes, actFirstAllowed false", async () => {
    expect(BILLING_APPROVAL_TYPES.map((s) => s.typeKey)).toEqual([
      "billing_credit_extension", "billing_credit_owner", "billing_discount", "billing_clearance_discount", "billing_refund", "billing_variance",
      "billing_refund_owner", "billing_recon_charge_owner",
    ]);
    await registerBillingApprovalTypes(db, ACTIVATOR);
    for (const spec of BILLING_APPROVAL_TYPES) {
      const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
      expect(row).not.toBeNull();
      expect(row!.approverRole).toBe(OWNER_TYPES.includes(spec.typeKey) ? "owner" : "billing_manager");
      expect(row!.urgencyClass).toBe(spec.urgencyClass);
      expect(row!.actFirstAllowed).toBe(false);
    }
    const ownerType = await withTx(db, (tx) => getApprovalType(tx, "billing_credit_owner"));
    expect(ownerType).toMatchObject({ approverRole: "owner", urgencyClass: "urgent", actFirstAllowed: false });
  });

  test("idempotent on a second call: no throw, all eight still registered, exactly once each", async () => {
    await registerBillingApprovalTypes(db, ACTIVATOR);
    await expect(registerBillingApprovalTypes(db, ACTIVATOR)).resolves.toBeUndefined();
    for (const spec of BILLING_APPROVAL_TYPES) {
      const row = await withTx(db, (tx) => getApprovalType(tx, spec.typeKey));
      expect(row).not.toBeNull();
      expect(row!.typeKey).toBe(spec.typeKey);
    }
  });
});
