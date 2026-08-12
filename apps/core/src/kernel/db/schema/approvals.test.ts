import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { approvalTypes, approvals } from "./approvals";
import { workflowDefinitions, workflowInstances } from "./workflow";
import type { Db } from "../client";

const DEF_JSON = {
  key: "approval_discount_override",
  title: "Discount Override",
  changeClass: "C",
  initialState: "pending",
  states: [
    { name: "pending", sla: { minutes: 45, alerting: "active" } },
    { name: "granted", terminal: true },
    { name: "rejected", terminal: true },
  ],
  transitions: [
    { from: "pending", to: "granted", roles: ["billing_head"] },
    { from: "pending", to: "rejected", roles: ["billing_head"] },
  ],
};

describe("approvals tables", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  async function seedInstance(instanceId: string): Promise<void> {
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "approval_discount_override", version: 1,
      title: "Discount Override", changeClass: "C", definition: DEF_JSON, draftedBy: "u1",
    }).onConflictDoNothing();
    await db.insert(workflowInstances).values({
      id: instanceId, definitionId: "01HDEF000000000000000000A",
      defKey: "approval_discount_override", currentState: "pending",
      subjectType: "invoice", subjectId: "inv1", stateEnteredAt: new Date(),
    });
  }

  it("applies defaults on approval_types and enforces its primary key", async () => {
    await db.insert(approvalTypes).values({
      typeKey: "discount_override", title: "Discount Override",
      defKey: "approval_discount_override", approverRole: "billing_head", createdBy: "u1",
    });
    const rows = await db.select().from(approvalTypes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.urgencyClass).toBe("routine");
    expect(rows[0]!.actFirstAllowed).toBe(false);
    await expect(
      db.insert(approvalTypes).values({
        typeKey: "discount_override", title: "Again",
        defKey: "approval_discount_override_2", approverRole: "billing_head", createdBy: "u1",
      }),
    ).rejects.toThrow(); // PK
  });

  it("FK-checks approvals against approval_types and workflow_instances", async () => {
    await seedInstance("01HINST00000000000000000A");
    await expect(
      db.insert(approvals).values({
        id: "01HAP1", typeKey: "missing_type", instanceId: "01HINST00000000000000000A",
        requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
        subjectType: "invoice", subjectId: "inv1",
      }),
    ).rejects.toThrow(); // FK to approval_types
    await db.insert(approvalTypes).values({
      typeKey: "discount_override", title: "Discount Override",
      defKey: "approval_discount_override", approverRole: "billing_head", createdBy: "u1",
    });
    await expect(
      db.insert(approvals).values({
        id: "01HAP2", typeKey: "discount_override", instanceId: "missing_instance",
        requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
        subjectType: "invoice", subjectId: "inv1",
      }),
    ).rejects.toThrow(); // FK to workflow_instances
  });

  it("applies defaults, keeps one approval per instance, and round-trips bigint paise as numbers", async () => {
    await seedInstance("01HINST00000000000000000A");
    await db.insert(approvalTypes).values({
      typeKey: "discount_override", title: "Discount Override",
      defKey: "approval_discount_override", approverRole: "billing_head", createdBy: "u1",
    });
    await db.insert(approvals).values({
      id: "01HAP1", typeKey: "discount_override", instanceId: "01HINST00000000000000000A",
      requesterId: "u1", approverRole: "billing_head", urgencyClass: "routine",
      subjectType: "invoice", subjectId: "inv1", patientId: "01HPAT000000000000000000A",
      amountPaise: 123_456_789_012, cumulativePatientPaise: 123_456_789_012,
    });
    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.actedFirst).toBe(false);
    // bigint mode:"number" — pg returns bigint as text; drizzle must hand back a real number
    // (the Plan 01 seq string/number trap, pinned here).
    expect(typeof rows[0]!.amountPaise).toBe("number");
    expect(rows[0]!.amountPaise).toBe(123_456_789_012);
    expect(rows[0]!.cumulativePatientPaise).toBe(123_456_789_012);
    await expect(
      db.insert(approvals).values({
        id: "01HAP2", typeKey: "discount_override", instanceId: "01HINST00000000000000000A",
        requesterId: "u2", approverRole: "billing_head", urgencyClass: "routine",
        subjectType: "invoice", subjectId: "inv1",
      }),
    ).rejects.toThrow(); // unique: one approval per instance
  });
});
