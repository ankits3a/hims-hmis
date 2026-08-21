import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { alerts, events, patients, workflowDefinitions, workflowInstances } from "../db/schema";
import { appendEvent } from "../events/append";
import { createUser } from "../auth/identity";
import { assignRole, createRole } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { buildSubscriptionBus } from "../worker/jobs";
import { escalationTriggered } from "../workflow/events";
import { ALERTS_CONSUMER, OWNER_ROLE, alertsConsumer } from "./consumer";
import { alertsManifest } from "./manifest";
import type { Db } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";

// §3.14: an absence assertion whose fixture could never have produced the thing proves nothing.
// The patient is real, she has a name and a UHID, the instance is bound to her, and the
// escalation event carries her patient_id — asserted as its own leg before any absence is.
const ASHA_NAME = "Asha Devi";
const ASHA_UHID = "HMIS-00004242-7";

const DEF_KEY = "opd_wait";
const STATE = "waiting";
const RUNG_ROLE = "floor_supervisor";
const DUTY_MANAGER_ROLE = "duty_manager";

type EscalationPayload = {
  instanceId: string;
  defKey: string;
  state: string;
  rung: number;
  role: string;
  resolvedUserIds: string[];
  fallback: boolean;
  fallbackExhausted: boolean;
};

describe("kernel alerts consumer", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let handler: Handler;
  let instanceId: string;
  let patientId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });

  const mkUser = async (username: string): Promise<string> => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    return id;
  };

  /**
   * Appends a REAL `escalation.triggered` row and reads it back into a `DispatchedEvent` exactly
   * as the dispatcher builds one — so the consumer is handed the same object shape production
   * hands it, `patientId` included.
   */
  const dispatched = async (
    payload: EscalationPayload,
    envelopePatientId: string | undefined,
  ): Promise<DispatchedEvent> => {
    const { eventId } = await withTx(db, (tx) =>
      appendEvent(
        tx,
        escalationTriggered.make({
          actor: { type: "system", id: "workflow-timer" },
          correlationId: payload.instanceId,
          patientId: envelopePatientId,
          payload,
        }),
      ),
    );
    const rows = await db
      .select({
        seq: events.seq,
        eventId: events.eventId,
        name: events.name,
        payload: events.payload,
        patientId: events.patientId,
        correlationId: events.correlationId,
      })
      .from(events)
      .where(eq(events.eventId, eventId));
    const row = rows[0]!;
    return {
      seq: Number(row.seq),
      eventId: row.eventId,
      name: row.name,
      payload: row.payload,
      patientId: row.patientId,
      correlationId: row.correlationId,
    };
  };

  beforeEach(async () => {
    await truncateAll(db);
    handler = alertsConsumer(db);

    patientId = newId();
    await db.insert(patients).values({
      id: patientId,
      uhid: ASHA_UHID,
      name: ASHA_NAME,
      sex: "female",
      createdBy: "seed",
      updatedBy: "seed",
    });

    const definitionId = newId();
    await db.insert(workflowDefinitions).values({
      id: definitionId,
      defKey: DEF_KEY,
      version: 1,
      title: "OPD wait",
      changeClass: "C",
      definition: { key: DEF_KEY, states: [] },
      draftedBy: "seed",
    });
    instanceId = newId();
    await db.insert(workflowInstances).values({
      id: instanceId,
      definitionId,
      defKey: DEF_KEY,
      currentState: STATE,
      subjectType: "opd_visit",
      subjectId: newId(),
      patientId, // the instance IS bound to Asha Devi — the leak M-A2 renders is one hop away
      stateEnteredAt: new Date(),
    });
  });

  it("binds the manifest's declared subscription to this consumer, and refuses a declaration it cannot serve", async () => {
    // Spike question D measured this seam as EMPTY — every shipped manifest declares
    // `subscriptions: []`. This is the first declaration it has ever carried, so the union it
    // produces is no longer the vacuous `[] === []` a checker would pass.
    expect(alertsManifest.subscriptions).toEqual([
      { event: "escalation.triggered", consumer: ALERTS_CONSUMER },
    ]);

    const registry = new ModuleRegistry();
    registry.install(alertsManifest);
    expect(registry.subscriptionsFor("escalation.triggered")).toEqual([
      { consumer: ALERTS_CONSUMER, moduleKey: "alerts" },
    ]);

    const bus = buildSubscriptionBus(registry, { [ALERTS_CONSUMER]: handler });
    expect(bus.consumers().map((c) => ({ consumer: c.consumer, events: c.events }))).toEqual([
      { consumer: ALERTS_CONSUMER, events: ["escalation.triggered"] },
    ]);

    // The boot error, not a silent skip: a module that declares a subscription nobody serves
    // must fail loudly, or the deliveries vanish with no error anywhere.
    expect(() => buildSubscriptionBus(registry, {})).toThrow(/kernel\.alerts/);
  });

  it("L7: the SAME dispatched event handed to the consumer twice yields one alert per recipient, and one alert.raised each", async () => {
    const nurse = await mkUser("l7nurse");
    const supervisor = await mkUser("l7supervisor");
    const event = await dispatched(
      {
        instanceId,
        defKey: DEF_KEY,
        state: STATE,
        rung: 0,
        role: RUNG_ROLE,
        resolvedUserIds: [nurse, supervisor],
        fallback: false,
        fallbackExhausted: false,
      },
      patientId,
    );

    // D4 is at-least-once BY DESIGN and the dispatcher has been observed invoking one handler
    // twice for one event. Capture the second outcome — never `await expect(x).rejects`, which
    // hangs forever on a promise a mutant makes resolve (§2.45).
    const outcomes: string[] = [];
    await handler(event);
    outcomes.push("first: resolved");
    try {
      await handler(event);
      outcomes.push("second: resolved");
    } catch (err) {
      outcomes.push(`second: threw ${err instanceof Error ? err.message : String(err)}`);
    }
    expect(outcomes).toEqual(["first: resolved", "second: resolved"]);

    const rows = await db
      .select({ id: alerts.id, userId: alerts.userId, sourceEventId: alerts.sourceEventId })
      .from(alerts);
    expect(rows).toHaveLength(2);
    expect([...new Set(rows.map((r) => r.userId))].sort()).toEqual([nurse, supervisor].sort());
    expect([...new Set(rows.map((r) => r.sourceEventId))]).toEqual([event.eventId]);

    // The claim is per (source_event_id, user_id) — so the second delivery appended NOTHING.
    const raised = await db.select({ id: events.eventId }).from(events).where(eq(events.name, "alert.raised"));
    expect(raised).toHaveLength(2);
  });

  it("L8: the escalation event carries the patient, and no alert column does", async () => {
    const supervisor = await mkUser("l8supervisor");
    const event = await dispatched(
      {
        instanceId,
        defKey: DEF_KEY,
        state: STATE,
        rung: 1,
        role: RUNG_ROLE,
        resolvedUserIds: [supervisor],
        fallback: false,
        fallbackExhausted: false,
      },
      patientId,
    );

    // THE FIXTURE-PROOF LEG. The identity is present and reachable: the stored event row carries
    // her patient_id, the consumer is handed it on `DispatchedEvent.patientId`, and a `patients`
    // row with her name and UHID is one query away. If this leg ever stops holding, the absence
    // below stops meaning anything.
    const stored = await db
      .select({ patientId: events.patientId })
      .from(events)
      .where(eq(events.eventId, event.eventId));
    expect(stored[0]!.patientId).toBe(patientId);
    expect(event.patientId).toBe(patientId);
    const patient = await db
      .select({ name: patients.name, uhid: patients.uhid })
      .from(patients)
      .where(eq(patients.id, patientId));
    expect(patient[0]).toEqual({ name: ASHA_NAME, uhid: ASHA_UHID });

    await handler(event);

    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    const alert = rows[0]!;
    // Every column, not a chosen few: whatever a future field is called, it is covered.
    const everyColumn = Object.values(alert)
      .map((v) => (v instanceof Date ? v.toISOString() : String(v)))
      .join(" | ");
    expect(everyColumn).not.toMatch(/Asha/i);
    expect(everyColumn).not.toMatch(/Devi/i);
    expect(everyColumn).not.toContain(ASHA_UHID);
    expect(everyColumn).not.toContain(patientId);
    // And the title is exactly what D6 says it is built from: defKey · state · rung.
    expect(alert.title).toBe(`Escalation: ${DEF_KEY} · ${STATE} · rung 1`);
    expect(alert.refType).toBe("workflow_instance");
    expect(alert.refId).toBe(instanceId);

    // The fan-out surface too: alert.raised rides the tail to a browser.
    const raised = await db
      .select({ payload: events.payload, patientId: events.patientId })
      .from(events)
      .where(eq(events.name, "alert.raised"));
    expect(raised).toHaveLength(1);
    expect(JSON.stringify(raised[0]!.payload)).not.toMatch(/Asha|Devi/i);
    expect(JSON.stringify(raised[0]!.payload)).not.toContain(ASHA_UHID);
    expect(raised[0]!.patientId).toBeNull();
  });

  it("L9: fallbackExhausted alerts every owner-role holder", async () => {
    // The rung role has ZERO holders and duty_manager has ZERO holders — which is what
    // `fallbackExhausted` MEANS — and two humans hold `owner`.
    await createRole(db, RUNG_ROLE, "Floor Supervisor");
    await createRole(db, DUTY_MANAGER_ROLE, "Duty Manager");
    await createRole(db, OWNER_ROLE, "Owner");
    const ownerOne = await mkUser("l9owner1");
    const ownerTwo = await mkUser("l9owner2");
    const bystander = await mkUser("l9bystander");
    await assignRole(db, { userId: ownerOne, roleKey: OWNER_ROLE, scopeType: "hospital" });
    await assignRole(db, { userId: ownerTwo, roleKey: OWNER_ROLE, scopeType: "hospital" });

    const event = await dispatched(
      {
        instanceId,
        defKey: DEF_KEY,
        state: STATE,
        rung: 2,
        role: RUNG_ROLE,
        resolvedUserIds: [], // the ladder resolved to nobody — that is the whole point
        fallback: true,
        fallbackExhausted: true,
      },
      patientId,
    );
    await handler(event);

    const rows = await db.select({ userId: alerts.userId }).from(alerts);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([ownerOne, ownerTwo].sort());
    expect(rows.map((r) => r.userId)).not.toContain(bystander);
  });
});
