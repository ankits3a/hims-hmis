import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { requestApproval } from "./requests";
import { registerApprovalType } from "./types";
import { approvalFlowDefinition } from "./flow";
import { createDraft, activateDefinition } from "../workflow/definitions";
import { createUser } from "../auth/identity";
import { seedSodPairs } from "../auth/sod";
import { approvals, events, workflowInstances, workflowTimers } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

const DRAFTER: Actor = { type: "user", id: "01HDRAFTER000000000000000" };
const PAT = "01HPAT000000000000000000A";

describe("requestApproval", () => {
  let db: Db; let teardown: () => Promise<void>;
  let activator: Actor; let requester: Actor;

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

  async function registerActFirstType(): Promise<void> {
    const def = approvalFlowDefinition({
      typeKey: "icu_admission", title: "ICU Admission",
      approverRole: "duty_doctor", closureSlaMinutes: 30,
    });
    const { definitionId } = await createDraft(db, DRAFTER, def);
    await activateDefinition(db, activator, definitionId);
    await registerApprovalType(db, activator, {
      typeKey: "icu_admission", title: "ICU Admission", approverRole: "duty_doctor",
      urgencyClass: "emergency", actFirstAllowed: true,
    });
  }

  it("starts a pending instance, snapshots C-12, and appends approval.requested", async () => {
    const { approvalId, instanceId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override",
        subject: { type: "invoice", id: "inv1" },
        patientId: PAT,
        amountPaise: 50_000,
        requestNote: "20% senior-citizen discount",
      }),
    );
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({
      typeKey: "discount_override",
      instanceId,
      requesterId: requester.id,
      approverRole: "billing_head", // snapshot from the type
      urgencyClass: "routine",      // snapshot from the type
      actedFirst: false,
      subjectType: "invoice",
      subjectId: "inv1",
      patientId: PAT,
      amountPaise: 50_000,
      cumulativePatientPaise: 50_000, // includes this request
      cumulativePayeePaise: null,     // no payee ref given
      status: "pending",
    });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance).toMatchObject({ currentState: "pending", status: "active", patientId: PAT });
    // Plan 03 scheduled the SLA timer from the definition's closure SLA — no timer code here.
    const timers = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );
    expect(timers).toHaveLength(1);
    expect(timers[0]!).toMatchObject({ kind: "sla", state: "pending" });
    expect(timers[0]!.dueAt.getTime()).toBe(instance!.stateEnteredAt.getTime() + 45 * 60_000);
    const evts = await db.select().from(events).where(eq(events.name, "approval.requested"));
    expect(evts).toHaveLength(1);
    expect(evts[0]!.correlationId).toBe(instanceId);
    expect(evts[0]!.patientId).toBe(PAT);
    expect(evts[0]!.payload).toMatchObject({
      approvalId, typeKey: "discount_override", approverRole: "billing_head",
      urgencyClass: "routine", actedFirst: false, slaMinutes: 45,
      amountPaise: 50_000, cumulativePatientPaise: 50_000,
    });
  });

  it("accumulates the same-day cumulative across sequential requests (C-12)", async () => {
    await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
        patientId: PAT, amountPaise: 50_000,
      }),
    );
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "invoice", id: "inv2" },
        patientId: PAT, amountPaise: 80_000,
      }),
    );
    const [second] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(second!.cumulativePatientPaise).toBe(130_000);
  });

  it("snapshots payee aggregation independently", async () => {
    const PAYEE = "01HPAYEE00000000000000000";
    await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "payout", id: "p1" },
        payeeId: PAYEE, amountPaise: 20_000,
      }),
    );
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "discount_override", subject: { type: "payout", id: "p2" },
        payeeId: PAYEE, amountPaise: 30_000,
      }),
    );
    const [second] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(second!.cumulativePayeePaise).toBe(50_000);
    expect(second!.cumulativePatientPaise).toBeNull();
  });

  it("act-first: allowed only where the type allows it, and only with a justification note", async () => {
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          actFirst: true, requestNote: "urgent",
        }),
      ),
    ).rejects.toMatchObject({ code: "act_first_not_allowed" });
    await registerActFirstType();
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "icu_admission", subject: { type: "encounter", id: "e1" },
          actFirst: true, requestNote: "   ",
        }),
      ),
    ).rejects.toMatchObject({ code: "note_required" });
    const { approvalId } = await withTx(db, (tx) =>
      requestApproval(tx, requester, {
        typeKey: "icu_admission", subject: { type: "encounter", id: "e1" },
        patientId: PAT, actFirst: true, requestNote: "patient unstable — admitted first (E-15)",
      }),
    );
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({ actedFirst: true, urgencyClass: "emergency" });
    const evts = await db.select().from(events).where(eq(events.name, "approval.requested"));
    expect(evts[0]!.payload).toMatchObject({ actedFirst: true, urgencyClass: "emergency" });
  });

  it("fails loud when a later definition version drops the type's approver role (drift guard)", async () => {
    // v2 changes the approver role; the type row (insert-only) still names billing_head.
    // A new request must refuse with definition_mismatch rather than snapshot a role the
    // pinned instance would deny at decision time.
    const defV2 = approvalFlowDefinition({
      typeKey: "discount_override", title: "Discount Override v2",
      approverRole: "finance_director", closureSlaMinutes: 45,
    });
    const { definitionId } = await createDraft(db, DRAFTER, defV2);
    await activateDefinition(db, activator, definitionId); // retires v1
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
        }),
      ),
    ).rejects.toMatchObject({ code: "definition_mismatch" });
  });

  it("validates money inputs (positive integer paise; needs a C-12 target)", async () => {
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          patientId: PAT, amountPaise: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          patientId: PAT, amountPaise: 12.5,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, {
          typeKey: "discount_override", subject: { type: "invoice", id: "inv1" },
          amountPaise: 1_000,
        }),
      ),
    ).rejects.toMatchObject({ code: "amount_needs_target" });
  });

  it("refuses unknown types and non-user actors", async () => {
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, requester, { typeKey: "nope", subject: { type: "t", id: "s" } }),
      ),
    ).rejects.toMatchObject({ code: "unknown_type" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, { type: "agent", id: "a1" }, {
          typeKey: "discount_override", subject: { type: "t", id: "s" },
        }),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
    await expect(
      withTx(db, (tx) =>
        requestApproval(tx, { type: "system", id: "sys" }, {
          typeKey: "discount_override", subject: { type: "t", id: "s" },
        }),
      ),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });
});
