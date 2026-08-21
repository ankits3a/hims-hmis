import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { events, notifications, patients } from "../db/schema";
import { appendEvent } from "../events/append";
import { createUser } from "../auth/identity";
import { assignRole, createRole } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { buildSubscriptionBus } from "../worker/jobs";
import { escalationTriggered } from "../workflow/events";
import { appointmentBooked, appointmentCancelled, appointmentRescheduled } from "../../modules/opd/events";
import { patientRegistered } from "../../modules/patients/events";
import { NOTIFY_CONSUMER, OWNER_ROLE, notifyConsumer } from "./consumer";
import { notifyManifest } from "./manifest";
import type { EventInput } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { DispatchedEvent, Handler } from "../events/subscriptions";

/**
 * §3.14 again: the patient is REAL, she has a name, a UHID and a phone, and every event below
 * carries her id on its envelope. Both of this file's identity-absence assertions (N10, and the
 * welcome's params) are only worth something because the identity was reachable and was not taken.
 */
const ASHA_NAME = "Asha Devi";
const ASHA_UHID = "HMIS-00004242-7";
const ASHA_PHONE = "9876500001";

const DEF_KEY = "opd_wait";
const STATE = "waiting";
const RUNG_ROLE = "floor_supervisor";
const HOUR_MS = 60 * 60 * 1000;

/**
 * The EVENT's own time — every assertion in this file about scheduling or expiry is anchored on
 * THIS instant and never on the clock the handler happens to run under (D5). 2026-08-21 11:30 IST.
 */
const OCCURRED_AT = new Date("2026-08-21T06:00:00.000Z");

const iso = (d: Date): string => d.toISOString();
const plus = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

describe("kernel notify consumer — five subscriptions, and nothing but enqueues (Plan 10 T5, D13)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let handler: Handler;
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
   * Appends a REAL event row and reads it back into a `DispatchedEvent` exactly as `dispatcher.ts`
   * builds one — `occurredAt` included. Nothing in this file hand-writes an envelope: the shape
   * the handler is tested against is the shape the dispatcher projects.
   */
  const dispatch = async (input: EventInput): Promise<DispatchedEvent> => {
    const { eventId } = await withTx(db, (tx) => appendEvent(tx, input));
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

  const registeredEvent = (occurredAt = OCCURRED_AT): EventInput =>
    patientRegistered.make({
      actor: { type: "system", id: "registration" },
      occurredAt,
      patientId,
      payload: { patientId, uhid: ASHA_UHID, name: ASHA_NAME, phone: ASHA_PHONE, language: "hi" },
    });

  const bookedEvent = (args: {
    appointmentId: string;
    slotStart: Date;
    serviceDate: string;
    occurredAt?: Date;
  }): EventInput =>
    appointmentBooked.make({
      actor: { type: "user", id: "desk-1" },
      occurredAt: args.occurredAt ?? OCCURRED_AT,
      patientId,
      payload: {
        appointmentId: args.appointmentId,
        patientId,
        doctorId: "doc-1",
        departmentId: "dept-1",
        serviceDate: args.serviceDate,
        slotStart: iso(args.slotStart),
        source: "desk",
      },
    });

  const escalationEvent = (args: {
    resolvedUserIds: string[];
    fallbackExhausted: boolean;
    occurredAt?: Date;
  }): EventInput =>
    escalationTriggered.make({
      actor: { type: "system", id: "workflow-timer" },
      occurredAt: args.occurredAt ?? OCCURRED_AT,
      // THE ENVELOPE CARRIES THE PATIENT. That is the fixture proof for N10: the wrong
      // implementation is one property access away and the property is populated.
      patientId,
      payload: {
        instanceId: "wfi-1",
        defKey: DEF_KEY,
        state: STATE,
        rung: 2,
        role: RUNG_ROLE,
        resolvedUserIds: args.resolvedUserIds,
        fallback: args.fallbackExhausted,
        fallbackExhausted: args.fallbackExhausted,
      },
    });

  const outbox = async (): Promise<(typeof notifications.$inferSelect)[]> =>
    [...(await db.select().from(notifications))].sort((a, b) =>
      a.templateKey < b.templateKey ? -1 : a.templateKey > b.templateKey ? 1 : a.id < b.id ? -1 : 1,
    );

  beforeEach(async () => {
    await truncateAll(db);
    handler = notifyConsumer(db);
    patientId = newId();
    await db.insert(patients).values({
      id: patientId,
      uhid: ASHA_UHID,
      name: ASHA_NAME,
      sex: "female",
      phone: ASHA_PHONE,
      createdBy: "seed",
      updatedBy: "seed",
    });
  });

  // ————————————————————————————————— the wire (both halves) —————————————————————————————————

  it("declares EXACTLY the five subscriptions it handles, and refuses a declaration it cannot serve", async () => {
    // Amendment 6 made a declaration with no handler a BOOT error, so the manifest and this
    // consumer are one edit. Whole-array equality: exactly these five, and nothing else.
    expect(notifyManifest.subscriptions).toEqual([
      { event: "appointment.booked", consumer: NOTIFY_CONSUMER },
      { event: "appointment.cancelled", consumer: NOTIFY_CONSUMER },
      { event: "appointment.rescheduled", consumer: NOTIFY_CONSUMER },
      { event: "escalation.triggered", consumer: NOTIFY_CONSUMER },
      { event: "patient.registered", consumer: NOTIFY_CONSUMER },
    ]);
    expect(NOTIFY_CONSUMER).toBe("kernel.notify");

    // The declared names are the SHIPPED catalog's own names, not strings that merely look like
    // them: a typo here would declare a subscription no producer can ever satisfy, and nothing
    // else in the build would notice.
    expect(notifyManifest.subscriptions.map((s) => s.event).sort()).toEqual(
      [
        appointmentBooked.name,
        appointmentCancelled.name,
        appointmentRescheduled.name,
        escalationTriggered.name,
        patientRegistered.name,
      ].sort(),
    );

    const registry = new ModuleRegistry();
    registry.install(notifyManifest);
    const bus = buildSubscriptionBus(registry, { [NOTIFY_CONSUMER]: handler });
    expect(bus.consumers().map((c) => ({ consumer: c.consumer, events: [...c.events].sort() }))).toEqual([
      {
        consumer: NOTIFY_CONSUMER,
        events: [
          "appointment.booked",
          "appointment.cancelled",
          "appointment.rescheduled",
          "escalation.triggered",
          "patient.registered",
        ],
      },
    ]);

    expect(() => buildSubscriptionBus(registry, {})).toThrow(/kernel\.notify/);
  });

  it("throws on an event no branch serves, rather than dropping the message", async () => {
    const stray = await dispatch(
      patientRegistered.make({
        actor: { type: "system", id: "registration" },
        occurredAt: OCCURRED_AT,
        patientId,
        payload: { patientId, uhid: ASHA_UHID, name: ASHA_NAME, phone: null, language: "hi" },
      }),
    );
    const outcome = await handler({ ...stray, name: "visit.opened" }).then(
      () => "resolved" as const,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(outcome).toMatch(/no branch for event "visit\.opened"/);
    expect(await outbox()).toHaveLength(0);
  });

  // ————————————————————————————————— patient.registered —————————————————————————————————

  it("patient.registered enqueues one welcome, with ONLY the uhid in its params", async () => {
    const event = await dispatch(registeredEvent());
    await handler(event);

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.templateKey).toBe("patient_welcome");
    expect(row.audience).toBe("patient");
    expect(row.patientId).toBe(patientId);
    expect(row.userId).toBeNull();
    expect(row.status).toBe("queued");
    expect(row.scheduledFor).toBeNull();
    expect(row.sourceEventId).toBe(event.eventId);
    expect(row.dedupeKey).toBe(`n:${event.eventId}:patient_welcome:${patientId}`);

    // The event payload carries her NAME and her PHONE. Neither is copied: the outbox stores no
    // contact truth (D4) and the template renders no name (D8). Whole-object equality, so a
    // future field of any name has to justify itself here.
    expect(row.params).toEqual({ uhid: ASHA_UHID });

    // D5: expiry is computed from the EVENT's time by the template, not from the handler's clock.
    expect(row.occurredAt).toEqual(OCCURRED_AT);
    expect(row.expiresAt).toEqual(plus(OCCURRED_AT, 24 * HOUR_MS));
  });

  it("D5: a REPLAYED registration expires from the event's own time, not from now", async () => {
    // Three days late — the exact §5.3 replay hazard. A handler reading the wall clock would give
    // this row a fresh 24-hour life and message a patient who registered last week.
    const longAgo = plus(new Date(), -72 * HOUR_MS);
    await handler(await dispatch(registeredEvent(longAgo)));

    const row = (await outbox())[0]!;
    expect(row.occurredAt).toEqual(longAgo);
    expect(row.expiresAt).toEqual(plus(longAgo, 24 * HOUR_MS));
    expect(row.expiresAt.getTime()).toBeLessThan(Date.now()); // already dead on arrival
  });

  // ————————————————————————————————— appointment.booked —————————————————————————————————

  it("appointment.booked enqueues the confirmation now and the reminder at slotStart − 24 h", async () => {
    const appointmentId = "appt-1";
    const slotStart = plus(OCCURRED_AT, 72 * HOUR_MS);
    const event = await dispatch(bookedEvent({ appointmentId, slotStart, serviceDate: "2026-08-24" }));
    await handler(event);

    const rows = await outbox();
    expect(rows.map((r) => r.templateKey)).toEqual(["appointment_confirmed", "appointment_reminder"]);

    const confirmed = rows[0]!;
    const reminder = rows[1]!;
    const params = { serviceDate: "2026-08-24", slotStart: iso(slotStart) };

    expect(confirmed.scheduledFor).toBeNull(); // due immediately
    expect(confirmed.params).toEqual(params);
    expect(confirmed.refType).toBe("appointment");
    expect(confirmed.refId).toBe(appointmentId);
    expect(confirmed.expiresAt).toEqual(slotStart); // D5: dies when the appointment starts

    expect(reminder.scheduledFor).toEqual(plus(slotStart, -24 * HOUR_MS));
    expect(reminder.params).toEqual(params);
    expect(reminder.refType).toBe("appointment");
    expect(reminder.refId).toBe(appointmentId);
    expect(reminder.expiresAt).toEqual(slotStart);
    expect(reminder.dedupeKey).toBe(`n:${event.eventId}:appointment_reminder:${patientId}`);
  });

  it("the reminder's one-hour notice window is measured from occurredAt, and both sides of it are pinned", async () => {
    // Exactly 25 h out: slotStart − 24 h lands exactly 1 h ahead of the event, which D13 admits.
    await handler(
      await dispatch(
        bookedEvent({
          appointmentId: "appt-edge-in",
          slotStart: plus(OCCURRED_AT, 25 * HOUR_MS),
          serviceDate: "2026-08-22",
        }),
      ),
    );
    expect((await outbox()).map((r) => r.templateKey)).toEqual([
      "appointment_confirmed",
      "appointment_reminder",
    ]);

    await truncateAll(db);
    await db.insert(patients).values({
      id: patientId, uhid: ASHA_UHID, name: ASHA_NAME, sex: "female", phone: ASHA_PHONE,
      createdBy: "seed", updatedBy: "seed",
    });

    // One millisecond under it: there is no 24-hour reminder left to give, so only the
    // confirmation goes out. A reminder here would arrive 59 minutes and 59.999 seconds from now.
    await handler(
      await dispatch(
        bookedEvent({
          appointmentId: "appt-edge-out",
          slotStart: plus(OCCURRED_AT, 25 * HOUR_MS - 1),
          serviceDate: "2026-08-22",
        }),
      ),
    );
    expect((await outbox()).map((r) => r.templateKey)).toEqual(["appointment_confirmed"]);
  });

  // ——————————————————————— appointment.rescheduled / .cancelled ———————————————————————

  it("appointment.rescheduled expires the old slot's queued rows and enqueues the new slot's pair", async () => {
    const oldSlot = plus(OCCURRED_AT, 72 * HOUR_MS);
    await handler(
      await dispatch(bookedEvent({ appointmentId: "appt-old", slotStart: oldSlot, serviceDate: "2026-08-24" })),
    );
    expect(await outbox()).toHaveLength(2);

    const newSlot = plus(OCCURRED_AT, 120 * HOUR_MS);
    const moved = await dispatch(
      appointmentRescheduled.make({
        actor: { type: "user", id: "desk-1" },
        occurredAt: plus(OCCURRED_AT, HOUR_MS),
        patientId,
        payload: {
          fromAppointmentId: "appt-old",
          toAppointmentId: "appt-new",
          patientId,
          doctorId: "doc-1",
          departmentId: "dept-1",
          serviceDate: "2026-08-26",
          slotStart: iso(newSlot),
          previousDoctorId: "doc-1",
          previousSlotStart: iso(oldSlot),
        },
      }),
    );
    await handler(moved);

    const rows = await outbox();
    expect(rows).toHaveLength(4);
    const expired = rows.filter((r) => r.refId === "appt-old");
    expect(expired.map((r) => r.status)).toEqual(["expired", "expired"]);
    const fresh = rows.filter((r) => r.refId === "appt-new");
    expect(fresh.map((r) => r.templateKey).sort()).toEqual([
      "appointment_confirmed",
      "appointment_reminder",
    ]);
    expect(fresh.map((r) => r.status)).toEqual(["queued", "queued"]);
    expect(fresh.every((r) => r.expiresAt.getTime() === newSlot.getTime())).toBe(true);

    // Expire-by-ref appends one `notification.expired` per WON row — not per call, not per ref.
    const expiredEvents = await db
      .select({ id: events.eventId })
      .from(events)
      .where(eq(events.name, "notification.expired"));
    expect(expiredEvents).toHaveLength(2);
  });

  it("appointment.cancelled expires the queued rows and enqueues nothing", async () => {
    const slotStart = plus(OCCURRED_AT, 72 * HOUR_MS);
    await handler(
      await dispatch(bookedEvent({ appointmentId: "appt-x", slotStart, serviceDate: "2026-08-24" })),
    );

    await handler(
      await dispatch(
        appointmentCancelled.make({
          actor: { type: "user", id: "desk-1" },
          occurredAt: plus(OCCURRED_AT, HOUR_MS),
          patientId,
          payload: {
            appointmentId: "appt-x",
            patientId,
            doctorId: "doc-1",
            serviceDate: "2026-08-24",
            slotStart: iso(slotStart),
            reason: "patient called",
          },
        }),
      ),
    );

    const rows = await outbox();
    expect(rows).toHaveLength(2); // nothing new, and nothing deleted
    expect(rows.map((r) => r.status)).toEqual(["expired", "expired"]);
  });

  // ————————————————————————————————— escalation.triggered —————————————————————————————————

  it("N10: a staff enqueue's params are EXACTLY the four structural fields — no patient identity", async () => {
    const nurse = await mkUser("n10nurse");
    const supervisor = await mkUser("n10supervisor");
    const event = await dispatch(
      escalationEvent({ resolvedUserIds: [nurse, supervisor], fallbackExhausted: false }),
    );
    // The fixture proof: the identity IS on the argument the handler receives.
    expect(event.patientId).toBe(patientId);

    await handler(event);

    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.templateKey)).toEqual(["staff_escalation", "staff_escalation"]);
    expect(rows.map((r) => r.userId).sort()).toEqual([nurse, supervisor].sort());

    for (const row of rows) {
      // THE WHOLE OBJECT. A consumer that copies `e.patientId` into params fails right here,
      // whatever it calls the field (GC5, 08.5's L8/M-A2 class).
      expect(row.params).toEqual({ defKey: DEF_KEY, state: STATE, rung: 2, role: RUNG_ROLE });
      expect(row.audience).toBe("staff");
      expect(row.patientId).toBeNull(); // and the row itself carries no patient either
      expect(row.expiresAt).toEqual(plus(OCCURRED_AT, 4 * HOUR_MS));
    }

    // Belt and braces over every column of every row, the same sweep L8 makes over alerts.
    const everyColumn = rows
      .flatMap((r) => Object.values(r))
      .map((v) => (v instanceof Date ? v.toISOString() : JSON.stringify(v)))
      .join(" | ");
    expect(everyColumn).not.toMatch(/Asha|Devi/i);
    expect(everyColumn).not.toContain(ASHA_UHID);
    expect(everyColumn).not.toContain(ASHA_PHONE);
    expect(everyColumn).not.toContain(patientId);
  });

  it("fallbackExhausted reaches for the owner's phone — one owner_escalation_sms per owner-role holder", async () => {
    await createRole(db, OWNER_ROLE, "Owner");
    const ownerOne = await mkUser("n5owner1");
    const ownerTwo = await mkUser("n5owner2");
    const bystander = await mkUser("n5bystander");
    await assignRole(db, { userId: ownerOne, roleKey: OWNER_ROLE, scopeType: "hospital" });
    await assignRole(db, { userId: ownerTwo, roleKey: OWNER_ROLE, scopeType: "hospital" });

    // The ladder resolved to nobody — that is what fallbackExhausted MEANS (fix 11).
    const event = await dispatch(escalationEvent({ resolvedUserIds: [], fallbackExhausted: true }));
    await handler(event);

    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.templateKey)).toEqual(["owner_escalation_sms", "owner_escalation_sms"]);
    expect(rows.map((r) => r.userId).sort()).toEqual([ownerOne, ownerTwo].sort());
    expect(rows.map((r) => r.userId)).not.toContain(bystander);
    for (const row of rows) {
      expect(row.audience).toBe("owner");
      expect(row.params).toEqual({ defKey: DEF_KEY, state: STATE, rung: 2, role: RUNG_ROLE });
      expect(row.patientId).toBeNull();
      expect(row.dedupeKey).toBe(`n:${event.eventId}:owner_escalation_sms:${row.userId}`);
    }
  });

  it("a NOT-exhausted escalation reaches no owner at all", async () => {
    await createRole(db, OWNER_ROLE, "Owner");
    const owner = await mkUser("n5owner3");
    const nurse = await mkUser("n5nurse");
    await assignRole(db, { userId: owner, roleKey: OWNER_ROLE, scopeType: "hospital" });

    await handler(await dispatch(escalationEvent({ resolvedUserIds: [nurse], fallbackExhausted: false })));

    const rows = await outbox();
    expect(rows.map((r) => r.templateKey)).toEqual(["staff_escalation"]);
    expect(rows[0]!.userId).toBe(nurse);
  });

  // ————————————————————————————————— N6: at-least-once —————————————————————————————————

  it("N6: the SAME dispatched event handled twice enqueues exactly one row per recipient", async () => {
    await createRole(db, OWNER_ROLE, "Owner");
    const ownerOne = await mkUser("n6owner1");
    const ownerTwo = await mkUser("n6owner2");
    await assignRole(db, { userId: ownerOne, roleKey: OWNER_ROLE, scopeType: "hospital" });
    await assignRole(db, { userId: ownerTwo, roleKey: OWNER_ROLE, scopeType: "hospital" });
    const nurse = await mkUser("n6nurse");

    const registered = await dispatch(registeredEvent());
    const booked = await dispatch(
      bookedEvent({
        appointmentId: "appt-n6",
        slotStart: plus(OCCURRED_AT, 72 * HOUR_MS),
        serviceDate: "2026-08-24",
      }),
    );
    const escalated = await dispatch(
      escalationEvent({ resolvedUserIds: [nurse], fallbackExhausted: true }),
    );

    // At-least-once is the dispatcher's contract (D4/GC15) and two concurrent cycles have been
    // observed invoking one handler twice for one event. Capture the second outcome rather than
    // `await expect(...).rejects`, which hangs forever on a promise a mutant makes resolve.
    const outcomes: string[] = [];
    for (const event of [registered, booked, escalated]) {
      await handler(event);
      outcomes.push(`${event.name} first: resolved`);
      try {
        await handler(event);
        outcomes.push(`${event.name} second: resolved`);
      } catch (err) {
        outcomes.push(`${event.name} second: threw ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(outcomes).toEqual([
      "patient.registered first: resolved",
      "patient.registered second: resolved",
      "appointment.booked first: resolved",
      "appointment.booked second: resolved",
      "escalation.triggered first: resolved",
      "escalation.triggered second: resolved",
    ]);

    // 1 welcome + 2 appointment rows + 1 staff + 2 owner = six, not twelve. The dedupe key is
    // per (event, template, recipient), so the fan-outs are still whole.
    const rows = await outbox();
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.templateKey)).toEqual([
      "appointment_confirmed",
      "appointment_reminder",
      "owner_escalation_sms",
      "owner_escalation_sms",
      "patient_welcome",
      "staff_escalation",
    ]);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(6);
  });
});
