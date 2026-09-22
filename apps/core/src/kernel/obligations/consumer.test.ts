import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { alerts, approvalTypes, approvals, events, workflowTimers } from "../db/schema";
import { acknowledgeAlert } from "../alerts/alerts";
import { createUser } from "../auth/identity";
import { createRole } from "../auth/permissions";
import { seedSodPairs } from "../auth/sod";
import { activateDefinition, createDraft } from "../workflow/definitions";
import { startInstance } from "../workflow/instances";
import { obligationsConsumer } from "./consumer";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";

/**
 * ═══ PHASE O T1 / V5 — AN ACKNOWLEDGEMENT STOPS THE RESPOND CLOCK, AND NOTHING ELSE ═══
 *
 * The one behaviour this consumer has, and the reason it is worth a file of its own: the two
 * clocks are independent, and the way they stop being independent is somebody wiring "the human
 * answered" to `cancelOpenTimers`. Every test here asserts what SURVIVES the ack as hard as it
 * asserts what stops.
 */
const DEF = {
  key: "ack_flow",
  title: "Ack Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    {
      name: "open",
      sla: {
        minutes: 240, alerting: "active", respondMinutes: 30,
        ladder: [{ atPercent: 70, toRole: "supervisor" }, { atPercent: 100, toRole: "duty_manager" }],
      },
    },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};

describe("obligations consumer — an ack stops the respond clock", () => {
  let db: Db; let teardown: () => Promise<void>;
  let handler: Handler;
  let userId: string;
  let actor: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    handler = obligationsConsumer(db);
    const admin = await createUser(db, { username: "ackadmin", fullName: "A", password: "p1234567" });
    const { definitionId } = await createDraft(db, { type: "user", id: "01HDRAFTER000000000000000" }, DEF);
    await activateDefinition(db, { type: "user", id: admin.id }, definitionId);
    const u = await createUser(db, { username: "ackuser", fullName: "U", password: "p1234567", staffCode: "EMP-ACK1" });
    userId = u.id;
    actor = { type: "user", id: userId };
  });

  const startWithAlert = async (refType: string): Promise<{ instanceId: string; alertId: string }> => {
    const { instanceId } = await withTx(db, (tx) => startInstance(tx, "ack_flow", { type: "t", id: newId() }));
    let refId = instanceId;
    if (refType === "approval") {
      await db.insert(approvalTypes).values({
        typeKey: "ack_type", title: "Ack Type", defKey: "approval_ack_type",
        approverRole: "billing_manager", createdBy: "seed",
      });
      refId = newId();
      await db.insert(approvals).values({
        id: refId, typeKey: "ack_type", instanceId, requesterId: userId,
        approverRole: "billing_manager", urgencyClass: "routine",
        subjectType: "invoice", subjectId: newId(),
      });
    }
    const alertId = newId();
    await db.insert(alerts).values({
      id: alertId, userId, kind: "escalation", title: "open · no answer", refType, refId,
      sourceEventId: newId(),
    });
    return { instanceId, alertId };
  };

  /** Reads the `alert.acknowledged` row `acknowledgeAlert` just appended, as the dispatcher would. */
  const dispatchedAck = async (): Promise<DispatchedEvent> => {
    const rows = await db
      .select({
        seq: events.seq, eventId: events.eventId, name: events.name, payload: events.payload,
        patientId: events.patientId, correlationId: events.correlationId, occurredAt: events.occurredAt,
      })
      .from(events).where(eq(events.name, "alert.acknowledged"));
    const row = rows[rows.length - 1]!;
    return {
      seq: Number(row.seq), eventId: row.eventId, name: row.name, payload: row.payload,
      patientId: row.patientId, correlationId: row.correlationId, occurredAt: row.occurredAt,
    };
  };

  const openTimers = async (instanceId: string) =>
    db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)),
    );

  it("V5: an `owned` ack cancels the respond timer and leaves the sla timer and both rungs standing", async () => {
    const { instanceId, alertId } = await startWithAlert("workflow_instance");
    expect(await openTimers(instanceId)).toHaveLength(4); // sla + two rungs + respond

    await acknowledgeAlert(db, actor, alertId, { kind: "owned", untilMinutes: 30 });
    await handler(await dispatchedAck());

    const open = await openTimers(instanceId);
    expect(open.map((t) => t.kind).sort()).toEqual(["escalation", "escalation", "sla"]);
    // The budget is untouched: somebody saying "I have got this" is not the work being done.
    expect(open.filter((t) => t.kind === "sla")).toHaveLength(1);
  });

  it("V5: a `seen` ack stops it too — looking and saying so is an answer", async () => {
    const { instanceId, alertId } = await startWithAlert("workflow_instance");
    await acknowledgeAlert(db, actor, alertId, { kind: "seen" });
    await handler(await dispatchedAck());
    expect((await openTimers(instanceId)).filter((t) => t.kind === "respond")).toHaveLength(0);
  });

  it("G6: a HANDOVER does not stop the clock — passing a thing on is not answering it", async () => {
    const other = await createUser(db, { username: "ackother", fullName: "O", password: "p1234567", staffCode: "EMP-ACK2" });
    const { instanceId, alertId } = await startWithAlert("workflow_instance");

    await acknowledgeAlert(db, actor, alertId, { kind: "handed_over", handedToUserId: other.id });
    await handler(await dispatchedAck());

    // Still running, and still four: the ladder climbs on schedule while the record of who
    // passed it to whom sits on the alert row.
    expect(await openTimers(instanceId)).toHaveLength(4);
    expect((await openTimers(instanceId)).filter((t) => t.kind === "respond")).toHaveLength(1);
  });

  it("finds the instance behind an APPROVAL alert — the ref an approver opens is not the instance", async () => {
    const { instanceId, alertId } = await startWithAlert("approval");
    await acknowledgeAlert(db, actor, alertId, { kind: "seen" });
    await handler(await dispatchedAck());
    expect((await openTimers(instanceId)).filter((t) => t.kind === "respond")).toHaveLength(0);
  });

  it("an alert pointing at something with no instance behind it is a no-op, not a crash", async () => {
    const { instanceId } = await startWithAlert("workflow_instance");
    const patientAlertId = newId();
    await db.insert(alerts).values({
      id: patientAlertId, userId, kind: "manual_notify", title: "call her",
      refType: "patient", refId: newId(), sourceEventId: newId(),
    });

    await acknowledgeAlert(db, actor, patientAlertId, { kind: "seen" });
    await handler(await dispatchedAck());

    // The unrelated obligation's clocks are all exactly where they were.
    expect(await openTimers(instanceId)).toHaveLength(4);
  });

  it("a redelivery cancels nothing a second time — at-least-once needs no claim here", async () => {
    const { instanceId, alertId } = await startWithAlert("workflow_instance");
    await acknowledgeAlert(db, actor, alertId, { kind: "seen" });
    const e = await dispatchedAck();

    await handler(e);
    const afterFirst = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "respond")),
    );
    await handler(e);
    const afterSecond = await db.select().from(workflowTimers).where(
      and(eq(workflowTimers.instanceId, instanceId), eq(workflowTimers.kind, "respond")),
    );
    expect(afterSecond[0]!.cancelledAt).toEqual(afterFirst[0]!.cancelledAt);
  });

  it("an event this consumer does not subscribe to is ignored outright", async () => {
    await createRole(db, "supervisor", "Supervisor");
    const { instanceId } = await startWithAlert("workflow_instance");
    await handler({
      seq: 1, eventId: newId(), name: "sla.breached", payload: { instanceId },
      patientId: null, correlationId: null, occurredAt: new Date(),
    });
    expect(await openTimers(instanceId)).toHaveLength(4);
  });
});
