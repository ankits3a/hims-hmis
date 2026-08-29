import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { notifications, patients, users, events } from "../db/schema";
import { withTx } from "../db/client";
import { enqueueNotification, expireByRef } from "./enqueue";
import * as templatesMod from "./templates";
import type { NotificationTemplate } from "./templates";
import type { Db } from "../db/client";

const PATIENT_A = "01HT4ENQPATIENTA000000001";
const USER_A = "01HT4ENQUSERA00000000A001";
const EVENT_ID = "01HT4ENQSOURCEEVENT000001";

/** IST 11:30 — outside quiet hours, so nothing in this file depends on D7 by accident. */
const OCCURRED_AT = new Date("2026-08-21T06:00:00.000Z");
const WELCOME_PARAMS = { uhid: "HMS-00000001-5" };
const ESCALATION_PARAMS = { defKey: "opd_wait", state: "waiting", rung: 0, role: "duty_manager" };

describe("enqueueNotification / expireByRef — the outbox's only writer (Plan 10 T4, D9/D13)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT_A, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", administrativeGender: "female",
      phone: "9876500001", createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(users).values({
      id: USER_A, username: "t4enq", fullName: "T4 Enqueue", passwordHash: "x", phone: "9876500002",
    });
  });

  describe("the insert", () => {
    it("inserts a queued row and computes expires_at from the template and the EVENT's time", async () => {
      const result = await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "patient_welcome",
          params: WELCOME_PARAMS,
          dedupeKey: `n:${EVENT_ID}:patient_welcome:${PATIENT_A}`,
          occurredAt: OCCURRED_AT,
          patientId: PATIENT_A,
          sourceEventId: EVENT_ID,
        }),
      );

      expect(result).not.toBeNull();
      const rows = await db.select().from(notifications);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id).toBe(result!.id);
      expect(row.status).toBe("queued");
      expect(row.audience).toBe("patient"); // taken from the TEMPLATE, never from the caller
      expect(row.patientId).toBe(PATIENT_A);
      expect(row.userId).toBeNull();
      expect(row.occurredAt).toEqual(OCCURRED_AT);
      // D5: `patient_welcome` dies 24 h after registration, anchored on occurredAt — NOT on the
      // wall clock, which is what makes a replayed event expire instead of sending.
      expect(row.expiresAt).toEqual(new Date("2026-08-22T06:00:00.000Z"));
      expect(row.rung).toBe(0);
      expect(row.attempts).toBe(0);
      expect(row.scheduledFor).toBeNull();
    });

    it("carries scheduledFor and the ref pair through to the row", async () => {
      const slotStart = new Date("2026-08-25T04:30:00.000Z");
      await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "appointment_reminder",
          params: { serviceDate: "2026-08-25", slotStart: slotStart.toISOString() },
          dedupeKey: `n:${EVENT_ID}:appointment_reminder:${PATIENT_A}`,
          occurredAt: OCCURRED_AT,
          patientId: PATIENT_A,
          refType: "appointment",
          refId: "01HT4APPOINTMENT000000001",
          scheduledFor: new Date(slotStart.getTime() - 24 * 60 * 60 * 1000),
        }),
      );

      const row = (await db.select().from(notifications))[0]!;
      expect(row.refType).toBe("appointment");
      expect(row.refId).toBe("01HT4APPOINTMENT000000001");
      expect(row.scheduledFor).toEqual(new Date("2026-08-24T04:30:00.000Z"));
      expect(row.expiresAt).toEqual(slotStart); // the reminder dies when the slot does (D5)
    });

    it("returns null and inserts nothing when the dedupe key already exists (GC15)", async () => {
      const input = {
        templateKey: "patient_welcome",
        params: WELCOME_PARAMS,
        dedupeKey: `n:${EVENT_ID}:patient_welcome:${PATIENT_A}`,
        occurredAt: OCCURRED_AT,
        patientId: PATIENT_A,
      };
      const first = await withTx(db, (tx) => enqueueNotification(tx, input));
      const second = await withTx(db, (tx) => enqueueNotification(tx, input));

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await db.select().from(notifications)).toHaveLength(1);
    });

    it("enqueues a staff row on user_id with no patient linkage at all", async () => {
      await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "staff_escalation",
          params: ESCALATION_PARAMS,
          dedupeKey: `n:${EVENT_ID}:staff_escalation:${USER_A}`,
          occurredAt: OCCURRED_AT,
          userId: USER_A,
        }),
      );

      const row = (await db.select().from(notifications))[0]!;
      expect(row.audience).toBe("staff");
      expect(row.userId).toBe(USER_A);
      expect(row.patientId).toBeNull();
      expect(row.expiresAt).toEqual(new Date("2026-08-21T10:00:00.000Z")); // occurredAt + 4 h
    });
  });

  /**
   * D9 / Assertion Book N2, leg (a) — THE DISCRIMINATING LEG.
   *
   * The shipped catalog contains ZERO promotional templates, so an assertion that reads only the
   * real registry starts and ends at `[] === []` and would pass against a deleted refusal
   * (§2.49). Task 2 already built and ran the other half of this: `templates.test.ts`'s "D9's leg
   * (a)" block proved that a synthetic `class: "promotional"` entry goes into a
   * `templateByKey`-shaped accessor with no compile or runtime obstacle. THIS is the half that
   * task could not reach — `enqueueNotification` itself — and the synthetic is built the same way.
   */
  describe("the promotional refusal (D9, N2 leg a)", () => {
    const SYNTHETIC_KEY = "patient_promotional_offer";
    const synthetic: NotificationTemplate = {
      key: SYNTHETIC_KEY,
      version: 1,
      class: "promotional",
      audience: "patient",
      urgency: "routine",
      waApprovalStatus: "not_submitted",
      expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 24 * 60 * 60 * 1000),
      render: { en: () => "Special offer", hi: () => "विशेष प्रस्ताव" },
    };

    let spy: jest.SpyInstance;
    beforeEach(() => {
      // A test-local registry, reached the only way `enqueueNotification` reaches ANY template.
      const real = templatesMod.templateByKey;
      spy = jest
        .spyOn(templatesMod, "templateByKey")
        .mockImplementation((key: string) => (key === SYNTHETIC_KEY ? synthetic : real(key)));
    });
    afterEach(() => {
      spy.mockRestore();
    });

    it("THROWS on a promotional-class template and inserts nothing", async () => {
      await expect(
        withTx(db, (tx) =>
          enqueueNotification(tx, {
            templateKey: SYNTHETIC_KEY,
            params: {},
            dedupeKey: `n:${EVENT_ID}:${SYNTHETIC_KEY}:${PATIENT_A}`,
            occurredAt: OCCURRED_AT,
            patientId: PATIENT_A,
          }),
        ),
      ).rejects.toThrow(/promotional/);

      expect(await db.select().from(notifications)).toHaveLength(0);
    });

    it("still enqueues a transactional template while the synthetic registry is installed", async () => {
      // The control leg: the refusal above is about the CLASS, not about the spy — without this,
      // a mock that broke every lookup would pass the test above for the wrong reason.
      const result = await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "patient_welcome",
          params: WELCOME_PARAMS,
          dedupeKey: `n:${EVENT_ID}:patient_welcome:${PATIENT_A}`,
          occurredAt: OCCURRED_AT,
          patientId: PATIENT_A,
        }),
      );
      expect(result).not.toBeNull();
    });
  });

  describe("the validations that have no CHECK constraint behind them", () => {
    it("throws when the template key is not registered", async () => {
      await expect(
        withTx(db, (tx) =>
          enqueueNotification(tx, {
            templateKey: "no_such_template",
            params: {},
            dedupeKey: "n:x:no_such_template:p",
            occurredAt: OCCURRED_AT,
            patientId: PATIENT_A,
          }),
        ),
      ).rejects.toThrow(/no notification template registered/);
      expect(await db.select().from(notifications)).toHaveLength(0);
    });

    it("throws when a patient-audience template is enqueued with no patientId", async () => {
      await expect(
        withTx(db, (tx) =>
          enqueueNotification(tx, {
            templateKey: "patient_welcome",
            params: WELCOME_PARAMS,
            dedupeKey: "n:x:patient_welcome:none",
            occurredAt: OCCURRED_AT,
          }),
        ),
      ).rejects.toThrow(/patient-audience but no patientId/);
      expect(await db.select().from(notifications)).toHaveLength(0);
    });

    it("throws when a staff-audience template is enqueued with a patientId", async () => {
      await expect(
        withTx(db, (tx) =>
          enqueueNotification(tx, {
            templateKey: "staff_escalation",
            params: ESCALATION_PARAMS,
            dedupeKey: "n:x:staff_escalation:both",
            occurredAt: OCCURRED_AT,
            userId: USER_A,
            patientId: PATIENT_A,
          }),
        ),
      ).rejects.toThrow(/staff-audience but a patientId/);
      expect(await db.select().from(notifications)).toHaveLength(0);
    });
  });

  describe("expireByRef (D13)", () => {
    const REF_TYPE = "appointment";
    const REF_ID = "01HT4APPOINTMENT000000009";
    const NOW = new Date("2026-08-21T07:00:00.000Z");

    async function enqueueBoth(): Promise<void> {
      const slotStart = new Date("2026-08-25T04:30:00.000Z");
      for (const key of ["appointment_confirmed", "appointment_reminder"]) {
        await withTx(db, (tx) =>
          enqueueNotification(tx, {
            templateKey: key,
            params: { serviceDate: "2026-08-25", slotStart: slotStart.toISOString() },
            dedupeKey: `n:${EVENT_ID}:${key}:${PATIENT_A}`,
            occurredAt: OCCURRED_AT,
            patientId: PATIENT_A,
            refType: REF_TYPE,
            refId: REF_ID,
          }),
        );
      }
    }

    it("expires every queued row carrying the ref and appends notification.expired per WON row", async () => {
      await enqueueBoth();

      const expired = await withTx(db, (tx) => expireByRef(tx, REF_TYPE, REF_ID, NOW));

      expect(expired).toBe(2);
      const rows = await db.select().from(notifications);
      expect(rows.map((r) => r.status).sort()).toEqual(["expired", "expired"]);
      const appended = await db.select().from(events).where(eq(events.name, "notification.expired"));
      expect(appended).toHaveLength(2);
      expect(appended.map((e) => e.patientId)).toEqual([PATIENT_A, PATIENT_A]);
      expect(new Set(appended.map((e) => (e.payload as { templateKey: string }).templateKey))).toEqual(
        new Set(["appointment_confirmed", "appointment_reminder"]),
      );
    });

    it("NEVER touches a sending or a sent row — only 'queued' is expirable", async () => {
      await enqueueBoth();
      const rows = await db.select().from(notifications).orderBy(notifications.templateKey);
      await db.update(notifications).set({ status: "sending" }).where(eq(notifications.id, rows[0]!.id));
      await db.update(notifications).set({ status: "sent" }).where(eq(notifications.id, rows[1]!.id));

      const expired = await withTx(db, (tx) => expireByRef(tx, REF_TYPE, REF_ID, NOW));

      expect(expired).toBe(0);
      const after = await db.select().from(notifications).orderBy(notifications.templateKey);
      expect(after.map((r) => r.status)).toEqual(["sending", "sent"]);
      expect(await db.select().from(events).where(eq(events.name, "notification.expired"))).toHaveLength(0);
    });

    it("is idempotent: a second call wins nothing and appends nothing", async () => {
      await enqueueBoth();
      await withTx(db, (tx) => expireByRef(tx, REF_TYPE, REF_ID, NOW));

      const second = await withTx(db, (tx) => expireByRef(tx, REF_TYPE, REF_ID, NOW));

      expect(second).toBe(0);
      expect(await db.select().from(events).where(eq(events.name, "notification.expired"))).toHaveLength(2);
    });

    it("leaves a row with a different ref alone", async () => {
      await enqueueBoth();
      await withTx(db, (tx) =>
        enqueueNotification(tx, {
          templateKey: "patient_welcome",
          params: WELCOME_PARAMS,
          dedupeKey: `n:${EVENT_ID}:patient_welcome:${PATIENT_A}`,
          occurredAt: OCCURRED_AT,
          patientId: PATIENT_A,
        }),
      );

      await withTx(db, (tx) => expireByRef(tx, REF_TYPE, REF_ID, NOW));

      const untouched = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.templateKey, "patient_welcome"), eq(notifications.status, "queued")));
      expect(untouched).toHaveLength(1);
    });
  });
});
