import { desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import {
  alerts, configValidationReports, events, notifications, operatingModeChanges, patients,
  workflowDefinitions, workflowInstances,
} from "../db/schema";
import { appendEvent } from "../events/append";
import { createUser } from "../auth/identity";
import { assignRole, createRole } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { buildSubscriptionBus } from "../worker/jobs";
import { escalationTriggered } from "../workflow/events";
import { enqueueNotification } from "../notify/enqueue";
import { runNotifyPump } from "../notify/pump";
import { changeOperatingMode } from "../ops/mode";
import { ALERTS_CONSUMER, DUTY_MANAGER_ROLE, OWNER_ROLE, alertsConsumer } from "./consumer";
import { alertsManifest } from "./manifest";
import type { Db } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";
import type { ChannelAdapter } from "../notify/adapters";
import type { OperatingMode } from "../ops/mode";

// §3.14: an absence assertion whose fixture could never have produced the thing proves nothing.
// The patient is real, she has a name and a UHID, the instance is bound to her, and the
// escalation event carries her patient_id — asserted as its own leg before any absence is.
const ASHA_NAME = "Asha Devi";
const ASHA_UHID = "HMIS-00004242-7";

const ASHA_PHONE = "9876500001";

const DEF_KEY = "opd_wait";
const STATE = "waiting";
const RUNG_ROLE = "floor_supervisor";

/** 2026-08-21 11:30 IST — the middle of the day, so no pump cycle here trips quiet hours (D7). */
const NOON = new Date("2026-08-21T06:00:00.000Z");
const WELCOME_PARAMS = { uhid: ASHA_UHID };

/** An adapter that always says no — the ladder-exhaustion fixture N8 is built on. */
const alwaysThrows = (channel: ChannelAdapter["channel"]): ChannelAdapter => ({
  channel,
  async send() {
    throw new Error(`${channel} provider refused`);
  },
});
const REFUSING_ADAPTERS: Record<ChannelAdapter["channel"], ChannelAdapter> = {
  whatsapp: alwaysThrows("whatsapp"),
  sms: alwaysThrows("sms"),
};

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
  /**
   * Reads a stored event row back into a `DispatchedEvent` exactly as the dispatcher builds one —
   * `occurredAt` included (Plan 10 D5), so the consumer is handed the same object shape
   * production hands it and nothing here invents a field the dispatcher does not project.
   */
  const readDispatched = async (eventId: string): Promise<DispatchedEvent> => {
    const rows = await db
      .select({
        seq: events.seq,
        eventId: events.eventId,
        name: events.name,
        payload: events.payload,
        patientId: events.patientId,
        correlationId: events.correlationId,
        occurredAt: events.occurredAt,
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
      occurredAt: row.occurredAt,
    };
  };

  /** Appends a REAL `escalation.triggered` row and reads it back. */
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
    return readDispatched(eventId);
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
      // She HAS a number, so the desk flag below is earned by an EXHAUSTED LADDER rather than by
      // D-34's phoneless shortcut — two different rungs of D6, and only one of them is N8.
      phone: ASHA_PHONE,
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
      // Plan 10 D6: the desk flag is a SECOND subscription on this SAME consumer, not a second
      // consumer — 08.5's machinery is reused rather than duplicated.
      { event: "notification.failed", consumer: ALERTS_CONSUMER },
      // Plan 11c D4: the THIRD subscription on the SAME consumer. A mode change that touches
      // downtime or degraded becomes a row in front of every owner.
      { event: "ops.mode_changed", consumer: ALERTS_CONSUMER },
    ]);

    const registry = new ModuleRegistry();
    registry.install(alertsManifest);
    expect(registry.subscriptionsFor("escalation.triggered")).toEqual([
      { consumer: ALERTS_CONSUMER, moduleKey: "alerts" },
    ]);
    expect(registry.subscriptionsFor("notification.failed")).toEqual([
      { consumer: ALERTS_CONSUMER, moduleKey: "alerts" },
    ]);
    expect(registry.subscriptionsFor("ops.mode_changed")).toEqual([
      { consumer: ALERTS_CONSUMER, moduleKey: "alerts" },
    ]);

    const bus = buildSubscriptionBus(registry, { [ALERTS_CONSUMER]: handler });
    expect(bus.consumers().map((c) => ({ consumer: c.consumer, events: c.events }))).toEqual([
      {
        consumer: ALERTS_CONSUMER,
        events: ["escalation.triggered", "notification.failed", "ops.mode_changed"],
      },
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

  // ————————————— Plan 10 D6: the last patient rung is a human at a desk (N8) —————————————

  /**
   * N8, DRIVEN THROUGH THE REAL PUMP RATHER THAN THROUGH A HAND-WRITTEN EVENT.
   *
   * The desk flag exists for one situation: the machinery ran out of ways to reach a patient.
   * Asserting it from a `notification.failed` row typed out here would prove the branch parses a
   * payload; asserting it from a row the SHIPPED pump appended after a real ladder exhaustion
   * proves the two halves of D6 meet. `enqueueNotification` -> `runNotifyPump` with both adapters
   * refusing -> `undeliverable` + `notification.failed` -> this consumer -> a task in front of
   * every duty manager. Every step is production code; only the adapters are fakes.
   */
  describe("the manual_notify desk flag (D6 / N8)", () => {
    const enqueueWelcome = async (): Promise<void> => {
      await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "patient_welcome",
          params: WELCOME_PARAMS,
          dedupeKey: `n:${newId()}:patient_welcome:${patientId}`,
          occurredAt: NOON,
          patientId,
        }),
      );
    };

    /**
     * Two cycles at `maxAttemptsPerRung: 1` walk the whole patient ladder — whatsapp refuses,
     * the rung advances, sms refuses, and the rung after sms is the desk. Returns the failure
     * event as the dispatcher would hand it over.
     */
    const exhaustTheLadder = async (): Promise<DispatchedEvent> => {
      const opts = { adapters: REFUSING_ADAPTERS, maxAttemptsPerRung: 1 };
      await runNotifyPump(db, { ...opts, now: NOON });
      // Past the 2 s adapter-failure backoff the first cycle wrote.
      await runNotifyPump(db, { ...opts, now: new Date(NOON.getTime() + 10_000) });

      const outbox = await db
        .select({ status: notifications.status })
        .from(notifications);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.status).toBe("undeliverable");

      const failures = await db
        .select({ eventId: events.eventId, payload: events.payload, patientId: events.patientId })
        .from(events)
        .where(eq(events.name, "notification.failed"));
      expect(failures).toHaveLength(1);
      // The fixture proof (§3.14): this really is a PATIENT-audience ladder exhaustion carrying
      // her id on the envelope. Without these two, the alert assertions below could pass against
      // a fixture that could never have produced a desk flag at all.
      expect(failures[0]!.payload).toMatchObject({ audience: "patient", reason: "ladder_exhausted" });
      expect(failures[0]!.patientId).toBe(patientId);

      return readDispatched(failures[0]!.eventId);
    };

    const seedDutyManagers = async (): Promise<{ dutyOne: string; dutyTwo: string; bystander: string }> => {
      await createRole(db, DUTY_MANAGER_ROLE, "Duty Manager");
      const dutyOne = await mkUser("n8duty1");
      const dutyTwo = await mkUser("n8duty2");
      const bystander = await mkUser("n8bystander");
      await assignRole(db, { userId: dutyOne, roleKey: DUTY_MANAGER_ROLE, scopeType: "hospital" });
      await assignRole(db, { userId: dutyTwo, roleKey: DUTY_MANAGER_ROLE, scopeType: "hospital" });
      return { dutyOne, dutyTwo, bystander };
    };

    it("N8: an exhausted patient ladder becomes a manual_notify task for EVERY duty manager", async () => {
      const { dutyOne, dutyTwo, bystander } = await seedDutyManagers();
      await enqueueWelcome();
      const event = await exhaustTheLadder();

      await handler(event);

      const rows = await db.select().from(alerts);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.userId).sort()).toEqual([dutyOne, dutyTwo].sort());
      expect(rows.map((r) => r.userId)).not.toContain(bystander);

      const row = rows[0]!;
      expect(row.kind).toBe("manual_notify");
      // The title is built from `templateKey` AND NOTHING ELSE (D6). Whole-string equality, so a
      // name, a phone or a rendered body appended to it fails here.
      expect(row.title).toBe("Notify manually: patient_welcome");
      // An ID, not an identity: the desk opens the patient through a permission-checked route.
      expect(row.refType).toBe("patient");
      expect(row.refId).toBe(patientId);
      expect(row.sourceEventId).toBe(event.eventId);

      // GC5 / L8's mutant class, applied to the new branch: every column of every row, whatever
      // a future field is called. `refId` IS the patient id by design, so THAT is asserted above
      // rather than forbidden here — what may never appear is the identity itself.
      const everyColumn = rows
        .flatMap((r) => Object.values(r))
        .map((v) => (v instanceof Date ? v.toISOString() : String(v)))
        .join(" | ");
      expect(everyColumn).not.toMatch(/Asha/i);
      expect(everyColumn).not.toMatch(/Devi/i);
      expect(everyColumn).not.toContain(ASHA_UHID);
      expect(everyColumn).not.toContain(ASHA_PHONE);

      // The push surface too — `alert.raised` rides the tail to a browser.
      const raised = await db
        .select({ payload: events.payload, patientId: events.patientId })
        .from(events)
        .where(eq(events.name, "alert.raised"));
      expect(raised).toHaveLength(2);
      const raisedJson = JSON.stringify(raised.map((r) => r.payload));
      expect(raisedJson).not.toMatch(/Asha|Devi/i);
      expect(raisedJson).not.toContain(ASHA_UHID);
      expect(raisedJson).not.toContain(ASHA_PHONE);
      expect(raised.map((r) => r.patientId)).toEqual([null, null]);
    });

    it("N8: redelivery of the same notification.failed adds no second task and no second push", async () => {
      const { dutyOne, dutyTwo } = await seedDutyManagers();
      await enqueueWelcome();
      const event = await exhaustTheLadder();

      // At-least-once is the dispatcher's contract (D4). Capture the second outcome rather than
      // `await expect(...).rejects`, which hangs forever on a promise a mutant makes resolve.
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

      const rows = await db.select({ userId: alerts.userId }).from(alerts);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.userId).sort()).toEqual([dutyOne, dutyTwo].sort());
      const raised = await db.select({ id: events.eventId }).from(events).where(eq(events.name, "alert.raised"));
      expect(raised).toHaveLength(2);
    });

    it("a STAFF failure raises no desk flag — 08.5's in-app alert already covers it (D6)", async () => {
      await seedDutyManagers();
      // A staff member with no phone at all: one cycle, no adapter reachable, `no_phone`.
      const phoneless = await mkUser("n8phoneless");
      await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "staff_escalation",
          params: { defKey: DEF_KEY, state: STATE, rung: 0, role: RUNG_ROLE },
          dedupeKey: `n:${newId()}:staff_escalation:${phoneless}`,
          occurredAt: NOON,
          userId: phoneless,
        }),
      );
      await runNotifyPump(db, { now: NOON, adapters: REFUSING_ADAPTERS });

      const failures = await db
        .select({ eventId: events.eventId, payload: events.payload })
        .from(events)
        .where(eq(events.name, "notification.failed"));
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ audience: "staff", reason: "no_phone" });

      await handler(await readDispatched(failures[0]!.eventId));

      expect(await db.select().from(alerts)).toEqual([]);
      expect(await db.select().from(events).where(eq(events.name, "alert.raised"))).toEqual([]);
    });

    it("keys on the notification.failed event's OWN id, so it cannot collide with an escalation alert", async () => {
      const { dutyOne, dutyTwo } = await seedDutyManagers();

      // The SAME duty manager is both an escalation recipient and a desk-task recipient. If the
      // desk task keyed on anything the escalation also keys on, the (source_event_id, user_id)
      // unique would swallow one of the two and a patient nobody could reach would go unflagged.
      const escalation = await dispatched(
        {
          instanceId,
          defKey: DEF_KEY,
          state: STATE,
          rung: 0,
          role: RUNG_ROLE,
          resolvedUserIds: [dutyOne, dutyTwo],
          fallback: false,
          fallbackExhausted: false,
        },
        patientId,
      );
      await handler(escalation);

      await enqueueWelcome();
      const failure = await exhaustTheLadder();
      await handler(failure);

      const rows = await db.select({ userId: alerts.userId, kind: alerts.kind, sourceEventId: alerts.sourceEventId }).from(alerts);
      expect(rows).toHaveLength(4);
      expect(rows.filter((r) => r.kind === "escalation")).toHaveLength(2);
      expect(rows.filter((r) => r.kind === "manual_notify")).toHaveLength(2);
      expect(rows.filter((r) => r.userId === dutyOne).map((r) => r.sourceEventId).sort()).toEqual(
        [escalation.eventId, failure.eventId].sort(),
      );
    });
  });

  // ————————————— Plan 11c D4: the owner learns the hospital went dark (V6) —————————————

  /**
   * V6. The third subscription, driven the same way the other two are: a REAL `ops.mode_changed`
   * row appended by the shipped `changeOperatingMode` and read back exactly as the dispatcher
   * projects it. Nothing here types out an event payload by hand — a branch that parses a
   * hand-written payload proves only that zod works.
   */
  describe("the operating-mode alert (11c D4 / V6)", () => {
    const DECLARED_AT = new Date("2026-08-23T09:00:00.000Z");
    const DOWNTIME_NOTE = "UPS failure in the server room — paper kit issued to both desks";

    /** A fresh, green validation report, so the commissioning exit is legal (D3). */
    const seedFreshOkReport = async (): Promise<void> => {
      await db.insert(configValidationReports).values({
        id: newId(),
        ok: true,
        scopes: { tariff: { ok: true }, billing: { ok: true } },
        at: new Date(DECLARED_AT.getTime() - 60 * 60 * 1000),
      });
    };

    /** Runs a real transition and hands back its event as the dispatcher would. */
    const declare = async (to: OperatingMode, note: string | null): Promise<DispatchedEvent> => {
      const { eventId } = await withTx(db, (tx) =>
        changeOperatingMode(tx, { type: "user", id: "duty-manager-1" }, { to, note }, DECLARED_AT),
      );
      return readDispatched(eventId);
    };

    /**
     * The `operating_mode_changes` row the latest declaration wrote — read from the TABLE, never
     * from the event payload, so V13 below compares the alert against the history row itself
     * rather than against another copy of the same string.
     */
    const latestChange = async (): Promise<{ id: string; fromMode: string; toMode: string }> => {
      const rows = await db
        .select({
          id: operatingModeChanges.id,
          fromMode: operatingModeChanges.fromMode,
          toMode: operatingModeChanges.toMode,
        })
        .from(operatingModeChanges)
        .orderBy(desc(operatingModeChanges.seq))
        .limit(1);
      return rows[0]!;
    };

    const seedOwners = async (): Promise<{ ownerOne: string; ownerTwo: string; bystander: string }> => {
      await createRole(db, OWNER_ROLE, "Owner");
      const ownerOne = await mkUser("v6owner1");
      const ownerTwo = await mkUser("v6owner2");
      const bystander = await mkUser("v6bystander");
      await assignRole(db, { userId: ownerOne, roleKey: OWNER_ROLE, scopeType: "hospital" });
      await assignRole(db, { userId: ownerTwo, roleKey: OWNER_ROLE, scopeType: "hospital" });
      return { ownerOne, ownerTwo, bystander };
    };

    it("V6: entering downtime alerts EVERY owner-role holder, and a redelivery adds nothing", async () => {
      const { ownerOne, ownerTwo, bystander } = await seedOwners();
      await seedFreshOkReport();
      await declare("normal", null); // commissioning → normal, through the real gate
      const event = await declare("downtime", DOWNTIME_NOTE);

      // The fixture proof (§3.14): this really is a downtime declaration with a note on it. If
      // this leg stops holding, everything below stops meaning anything.
      expect(event.name).toBe("ops.mode_changed");
      expect(event.payload).toMatchObject({ from: "normal", to: "downtime", note: DOWNTIME_NOTE });

      // At-least-once is the dispatcher's contract (D4). Capture the second outcome rather than
      // `await expect(...).rejects`, which hangs forever on a promise a mutant makes resolve.
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

      const rows = await db.select().from(alerts);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.userId).sort()).toEqual([ownerOne, ownerTwo].sort());
      expect(rows.map((r) => r.userId)).not.toContain(bystander);

      const row = rows[0]!;
      expect(row.kind).toBe("operating_mode");
      // Whole-string equality: the mode words and nothing else.
      expect(row.title).toBe("Operating mode: normal → downtime");
      expect(row.body).toBe(DOWNTIME_NOTE);
      expect(row.refType).toBe("operating_mode");
      // ───────────────────── 11d D6 / Book V13 — BOTH HALVES, now landed ─────────────────────
      // The payload carries `changeId` (T3), and the alert's `refId` IS that id (T4). Both are
      // asserted against the `operating_mode_changes` row read from the TABLE, never from the
      // payload and never a literal, so the two sides of each equality are independent.
      const change = await latestChange();
      expect(change.toMode).toBe("downtime"); // fixture proof: the row this alert is actually about
      expect(change.id).toHaveLength(26); // a ULID from newId(), not a mode word
      expect(event.payload).toMatchObject({ changeId: change.id });
      // THE SECOND HALF, chain-halted out of T3 and landed by T4 in one commit with the two other
      // readers (`alerts/consumer.ts` and `test/ops-lifecycle.e2e.test.ts` leg 4). `refId` was the
      // mode WORD in 11c where both other ref types in `consumer.ts` carry an entity id; Book
      // V13's mutant ("revert `refId` to the mode word") could not fail while the shipped code WAS
      // that mutant, and this whole-string equality is what makes it fail now.
      expect(row.refId).toBe(change.id);
      expect(row.sourceEventId).toBe(event.eventId);

      // The won-insert-only rule: the SECOND delivery appended nothing.
      const raised = await db.select({ id: events.eventId }).from(events).where(eq(events.name, "alert.raised"));
      expect(raised).toHaveLength(2);
    });

    it("V6: LEAVING downtime alerts too — coming back is as much news as going dark", async () => {
      const { ownerOne, ownerTwo } = await seedOwners();
      await seedFreshOkReport();
      await declare("normal", null);
      await declare("downtime", DOWNTIME_NOTE);
      const recovery = await declare("normal", null);

      await handler(recovery);

      const rows = await db.select({ userId: alerts.userId, title: alerts.title, body: alerts.body }).from(alerts);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.userId).sort()).toEqual([ownerOne, ownerTwo].sort());
      expect(rows[0]!.title).toBe("Operating mode: downtime → normal");
      // A recovery carries no mandatory note, and the body says so rather than being blank.
      expect(rows[0]!.body).toBe("The hospital moved from downtime to normal. No note was recorded.");
    });

    it("V6 CONTROL: ramp → normal raises nothing — a milestone is not an incident", async () => {
      await seedOwners();
      await seedFreshOkReport();
      await declare("ramp", null); // commissioning → ramp, through the real gate
      const event = await declare("normal", null);

      // The fixture proof: this transition really did happen and really was delivered.
      expect(event.payload).toMatchObject({ from: "ramp", to: "normal" });
      await handler(event);

      expect(await db.select().from(alerts)).toEqual([]);
      expect(await db.select().from(events).where(eq(events.name, "alert.raised"))).toEqual([]);
    });

    it("carries mode words and a note and NEVER patient identity (GC6)", async () => {
      await seedOwners();
      await seedFreshOkReport();
      await declare("normal", null);
      const event = await declare("degraded", DOWNTIME_NOTE);

      // The envelope itself never carried her: a mode change is a hospital-wide fact, and Asha
      // Devi is a real row one query away throughout this suite (see beforeEach).
      expect(event.patientId).toBeNull();
      await handler(event);

      const rows = await db.select().from(alerts);
      expect(rows).toHaveLength(2);
      const everyColumn = rows
        .flatMap((r) => Object.values(r))
        .map((v) => (v instanceof Date ? v.toISOString() : String(v)))
        .join(" | ");
      expect(everyColumn).not.toMatch(/Asha/i);
      expect(everyColumn).not.toMatch(/Devi/i);
      expect(everyColumn).not.toContain(ASHA_UHID);
      expect(everyColumn).not.toContain(ASHA_PHONE);
      expect(everyColumn).not.toContain(patientId);

      const raised = await db
        .select({ payload: events.payload, patientId: events.patientId })
        .from(events)
        .where(eq(events.name, "alert.raised"));
      expect(raised).toHaveLength(2);
      expect(raised.map((r) => r.patientId)).toEqual([null, null]);
      const raisedJson = JSON.stringify(raised.map((r) => r.payload));
      expect(raisedJson).not.toMatch(/Asha|Devi/i);
      expect(raisedJson).not.toContain(ASHA_UHID);
    });
  });
});
