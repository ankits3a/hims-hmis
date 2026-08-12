import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { approveRequest, rejectRequest, REQUESTER_APPROVER_PAIR } from "./decisions";
import { requestApproval } from "./requests";
import { registerApprovalType } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { createRole, assignRole } from "../auth/permissions";
import { seedSodPairs, SodViolationError } from "../auth/sod";
import { approvals, events, workflowInstances, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };

describe("approval decisions", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor; let requester: Actor; let approverA: Actor; let approverB: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    const mk = async (username: string): Promise<Actor> => {
      const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
      return { type: "user", id };
    };
    activator = await mk("activator1");
    requester = await mk("requester1");
    approverA = await mk("approver_a");
    approverB = await mk("approver_b");
    await createRole(db, "billing_head", "Billing Head");
    await assignRole(db, { userId: approverA.id, roleKey: "billing_head", scopeType: "hospital" });
    await assignRole(db, { userId: approverB.id, roleKey: "billing_head", scopeType: "hospital" });
    const def = approvalFlowDefinition({
      typeKey: "discount_override", title: "Discount Override",
      approverRole: "billing_head", closureSlaMinutes: 45,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
    await registerApprovalType(db, activator, {
      typeKey: "discount_override", title: "Discount Override", approverRole: "billing_head",
    });
  });

  async function fileRequest(by: Actor = requester): Promise<{ approvalId: string; instanceId: string }> {
    return withTx(db, (tx) =>
      requestApproval(tx, by, {
        typeKey: "discount_override",
        subject: { type: "invoice", id: "inv1" },
        patientId: "01HPAT000000000000000000A",
        amountPaise: 50_000,
      }),
    );
  }

  it("grants: instance completes, row mirrors, timers cancel, approval.granted appends", async () => {
    const { approvalId, instanceId } = await fileRequest();
    const result = await approveRequest(db, approverA, { approvalId, note: "verified against policy" });
    expect(result).toEqual({ status: "granted" });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({
      status: "granted", decisionNote: "verified against policy", decidedBy: approverA.id,
    });
    expect(row!.decidedAt).not.toBeNull();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "granted", status: "completed" });
    const open = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(open).toHaveLength(0); // Plan 03 cancelled the closure-SLA timer on the terminal move
    const evts = await db.select().from(events).where(eq(events.name, "approval.granted"));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.correlationId).toBe(instanceId);
    expect(evts[0]!.payload).toMatchObject({
      approvalId, decidedBy: approverA.id, note: "verified against policy", actedFirst: false,
    });
  });

  it("rejects: same mechanics, approval.rejected", async () => {
    const { approvalId, instanceId } = await fileRequest();
    const result = await rejectRequest(db, approverA, { approvalId, note: "policy cap exceeded" });
    expect(result).toEqual({ status: "rejected" });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "rejected", status: "completed" });
    const evts = await db.select().from(events).where(eq(events.name, "approval.rejected"));
    expect(evts).toHaveLength(1);
  });

  it("enforces the mandatory note at runtime, BEFORE any DB read", async () => {
    // Unknown id + blank note: if the note check ran after the lookup this would be
    // unknown_approval — the code pins the order (Plan 03 T8's lesson, runtime not types).
    await expect(
      approveRequest(db, approverA, { approvalId: "01HNOSUCH0000000000000000", note: "   " }),
    ).rejects.toMatchObject({ code: "note_required" });
    await expect(
      rejectRequest(db, approverA, { approvalId: "01HNOSUCH0000000000000000", note: "" }),
    ).rejects.toMatchObject({ code: "note_required" });
  });

  it("blocks requester=approver via the seeded SoD pair; the violation event survives", async () => {
    // The requester also holds the approver role — permission is not the gate, SoD is.
    await assignRole(db, { userId: requester.id, roleKey: "billing_head", scopeType: "hospital" });
    const { approvalId } = await fileRequest();
    await expect(
      approveRequest(db, requester, { approvalId, note: "approving my own request" }),
    ).rejects.toBeInstanceOf(SodViolationError);
    expect(REQUESTER_APPROVER_PAIR).toBe("requester_approver");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("pending"); // nothing moved
    const sodEvents = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(sodEvents).toHaveLength(1); // appended in its OWN tx — survives the refused decision
  });

  it("denies a user without the approver role (Plan 03 transition role check)", async () => {
    const { approvalId } = await fileRequest();
    await expect(
      approveRequest(db, activator, { approvalId, note: "not my call" }),
    ).rejects.toMatchObject({ code: "role_denied" });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("pending");
  });

  it("refuses agent and system actors", async () => {
    const { approvalId } = await fileRequest();
    await expect(
      approveRequest(db, { type: "agent", id: "a1" }, { approvalId, note: "agent decision" }),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    await expect(
      approveRequest(db, { type: "system", id: "sys" }, { approvalId, note: "auto-approve" }),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("single-winner: of two concurrent opposite decisions exactly one applies", async () => {
    const { approvalId, instanceId } = await fileRequest();
    const results = await Promise.allSettled([
      approveRequest(db, approverA, { approvalId, note: "approve in race" }),
      rejectRequest(db, approverB, { approvalId, note: "reject in race" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Three legal loser codes, and which one lands is pure timing — all three are the
    // arbiter refusing the second decision, none is re-implemented here:
    //   stale_transition   — the loser reached transition()'s conditional UPDATE and lost it
    //   instance_not_active — the winner's COMMIT beat the loser's instance read
    //   not_pending        — the winner's COMMIT beat the loser's fast-fail row read
    expect(["stale_transition", "not_pending", "instance_not_active"]).toContain(
      (rejected[0]!.reason as { code: string }).code,
    );
    // Row and instance moved together — the mirror never diverges from the arbiter.
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(row!.status).toBe(instance!.currentState);
    expect(instance!.status).toBe("completed");
    const decisionEvents = await db.select().from(events).where(eq(events.name, `approval.${row!.status}`));
    expect(decisionEvents).toHaveLength(1); // the loser appended nothing
  });

  it("refuses a decision on an already-decided approval and on an unknown id", async () => {
    const { approvalId } = await fileRequest();
    await approveRequest(db, approverA, { approvalId, note: "first decision" });
    await expect(
      rejectRequest(db, approverB, { approvalId, note: "second decision" }),
    ).rejects.toMatchObject({ code: "not_pending" });
    await expect(
      approveRequest(db, approverA, { approvalId: "01HNOSUCH0000000000000000", note: "who dis" }),
    ).rejects.toMatchObject({ code: "unknown_approval" });
  });
});
