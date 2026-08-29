import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { notifications } from "./notifications";
import { patients } from "./patients";
import { users } from "./auth";
import type { Db } from "../client";

const PATIENT_A = "01HNOTIFYPATIENTA0000000A";
const USER_A = "01HNOTIFYUSERA00000000AAA";
const EVENT_ID = "01HPATIENTREGISTERED00001";

const OCCURRED_AT = new Date("2026-08-21T04:30:00.000Z");
const EXPIRES_AT = new Date("2026-08-22T04:30:00.000Z");

const patientRow = (id: string, dedupeKey: string) => ({
  id,
  audience: "patient",
  patientId: PATIENT_A,
  templateKey: "patient_welcome",
  params: { uhid: "HMS-00000001-5" },
  dedupeKey,
  sourceEventId: EVENT_ID,
  occurredAt: OCCURRED_AT,
  expiresAt: EXPIRES_AT,
});

describe("migration 0015 — the notifications outbox and the three columns beside it", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    // If `notifications` were missing from EITHER truncate statement in test/helpers/db.ts, this
    // line — not any assertion below — is where every test in this file would die: Postgres
    // refuses to truncate `patients` or `users` while an FK constraint POINTS AT an un-named
    // table (§3.35, constraint existence, never row counts, never statement order).
    await truncateAll(db);
    await db.insert(patients).values({
      id: PATIENT_A, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", administrativeGender: "female",
      createdBy: "u1", updatedBy: "u1",
    });
    await db.insert(users).values({
      id: USER_A, username: "asha", fullName: "Asha K", passwordHash: "x",
    });
  });

  describe("the outbox row", () => {
    it("round-trips a queued patient row with every default applied", async () => {
      await db.insert(notifications).values(patientRow("01HNOTIF0000000000000001", "n:e1:patient_welcome:p1"));
      const rows = await db.select().from(notifications);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // The claim/ladder state a fresh row starts in (D2/D6).
      expect(row.status).toBe("queued");
      expect(row.rung).toBe(0);
      expect(row.attempts).toBe(0);
      expect(typeof row.rung).toBe("number"); // integer column — the string/number trap class
      expect(typeof row.attempts).toBe("number");

      // What the row carries — and note what it does NOT: no phone, no language, no deceased
      // flag. Contact truth is resolved at SEND time, deliberately (D4).
      expect(row.audience).toBe("patient");
      expect(row.patientId).toBe(PATIENT_A);
      expect(row.userId).toBeNull();
      expect(row.templateKey).toBe("patient_welcome");
      expect(row.params).toEqual({ uhid: "HMS-00000001-5" });
      expect(row.sourceEventId).toBe(EVENT_ID);
      expect(row.occurredAt).toEqual(OCCURRED_AT);
      expect(row.expiresAt).toEqual(EXPIRES_AT);

      // Everything the pump fills in later starts empty.
      expect(row.scheduledFor).toBeNull();
      expect(row.nextAttemptAt).toBeNull();
      expect(row.lastError).toBeNull();
      expect(row.sentAt).toBeNull();
      expect(row.sentChannel).toBeNull();
      expect(row.sentTemplateVersion).toBeNull();
      expect(row.refType).toBeNull();
      expect(row.refId).toBeNull();

      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    it("carries a staff row on user_id with no patient linkage at all (GC5)", async () => {
      await db.insert(notifications).values({
        id: "01HNOTIF0000000000000002",
        audience: "staff",
        userId: USER_A,
        templateKey: "staff_escalation",
        params: { defKey: "opd_wait", state: "waiting", rung: 0, role: "duty_manager" },
        dedupeKey: "n:e2:staff_escalation:u1",
        occurredAt: OCCURRED_AT,
        expiresAt: EXPIRES_AT,
      });
      const row = (await db.select().from(notifications))[0]!;
      expect(row.userId).toBe(USER_A);
      expect(row.patientId).toBeNull();
    });

    it("stores the expire-by-ref handle and a scheduled_for when the producer supplies them (D13)", async () => {
      await db.insert(notifications).values({
        ...patientRow("01HNOTIF0000000000000008", "n:e8:appointment_reminder:p1"),
        templateKey: "appointment_reminder",
        refType: "appointment",
        refId: "01HAPPOINTMENT0000000001",
        scheduledFor: new Date("2026-08-22T02:30:00.000Z"),
      });
      const row = (await db.select().from(notifications))[0]!;
      expect(row.refType).toBe("appointment");
      expect(row.refId).toBe("01HAPPOINTMENT0000000001");
      expect(row.scheduledFor).toEqual(new Date("2026-08-22T02:30:00.000Z"));
    });
  });

  describe("the dedupe key", () => {
    it("refuses a second row with the same dedupe_key — the key is UNIQUE (GC15)", async () => {
      await db.insert(notifications).values(patientRow("01HNOTIF0000000000000001", "n:e1:patient_welcome:p1"));
      await expect(
        db.insert(notifications).values(patientRow("01HNOTIF0000000000000003", "n:e1:patient_welcome:p1")),
      ).rejects.toThrow();
    });

    it("lets ON CONFLICT (dedupe_key) DO NOTHING absorb a redelivery instead of throwing", async () => {
      // The exact shape the consumer uses (D13/GC15): at-least-once redelivery must insert
      // NOTHING and must not surface as an error, or a redelivered event parks a consumer queue.
      await db.insert(notifications).values(patientRow("01HNOTIF0000000000000001", "n:e1:patient_welcome:p1"));
      await db.insert(notifications)
        .values(patientRow("01HNOTIF0000000000000003", "n:e1:patient_welcome:p1"))
        .onConflictDoNothing({ target: notifications.dedupeKey });
      const rows = await db.select().from(notifications);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("01HNOTIF0000000000000001"); // the FIRST row survives; nothing was overwritten
    });

    it("still accepts a DIFFERENT dedupe_key for the same patient and template", async () => {
      // Not-over-broad: a unique on (patient_id, template_key) would cap one patient at one
      // welcome ever, and no mutant on the dedupe_key unique catches a uniqueness that is too
      // WIDE. The dedupe unit is the key the caller composes (event id included), not the
      // recipient.
      await db.insert(notifications).values(patientRow("01HNOTIF0000000000000001", "n:e1:patient_welcome:p1"));
      await db.insert(notifications).values(patientRow("01HNOTIF0000000000000003", "n:e9:patient_welcome:p1"));
      expect(await db.select().from(notifications)).toHaveLength(2);
    });
  });

  describe("the constraints", () => {
    it("requires patient_id to name a real patient when it is set", async () => {
      await expect(
        db.insert(notifications).values({
          ...patientRow("01HNOTIF0000000000000004", "n:e4:patient_welcome:px"),
          patientId: "01HNOSUCHPATIENT00000000",
        }),
      ).rejects.toThrow();
    });

    it("requires user_id to name a real user when it is set", async () => {
      await expect(
        db.insert(notifications).values({
          id: "01HNOTIF0000000000000005",
          audience: "staff",
          userId: "01HNOSUCHUSER00000000000",
          templateKey: "staff_escalation",
          params: {},
          dedupeKey: "n:e5:staff_escalation:ux",
          occurredAt: OCCURRED_AT,
          expiresAt: EXPIRES_AT,
        }),
      ).rejects.toThrow();
    });

    it("refuses a row with no expires_at — staleness is structural, not optional (D5)", async () => {
      // Raw SQL: the drizzle insert type will not let the column be omitted, so the NOT NULL
      // that makes the D5 replay defence unskippable can only be observed from below the type
      // system.
      await expect(
        db.execute(sql`
          insert into notifications (id, audience, template_key, params, dedupe_key, occurred_at)
          values ('01HNOTIF0000000000000007', 'patient', 'patient_welcome', '{}'::jsonb, 'n:e7:x:y', now())
        `),
      ).rejects.toThrow();
    });

    it("does NOT enforce audience/recipient coherence — that is app-enforced, and this pins it", async () => {
      // Deliberate, and asserted rather than left to be discovered: an audience='patient' row
      // with no patient_id inserts fine at the DB layer. The invariant lives in
      // enqueueNotification (the only writer) and in the pump that reads it. A CHECK constraint
      // here would need re-migrating the first time an audience is added, and the enqueue API is
      // the narrower gate. If a later plan decides the database should enforce it, THIS test is
      // the one that must change first.
      await db.insert(notifications).values({
        id: "01HNOTIF0000000000000006",
        audience: "patient",
        templateKey: "patient_welcome",
        params: {},
        dedupeKey: "n:e6:patient_welcome:none",
        occurredAt: OCCURRED_AT,
        expiresAt: EXPIRES_AT,
      });
      const row = (await db.select().from(notifications))[0]!;
      expect(row.patientId).toBeNull();
      expect(row.userId).toBeNull();
    });

    it("carries exactly the four indexes the pump, the expire-by-ref path and the prune read", async () => {
      const rows = (await db.execute(sql`
        select indexname from pg_indexes where tablename = 'notifications' order by indexname
      `)).rows as { indexname: string }[];
      expect(rows.map((r) => r.indexname)).toEqual([
        "notifications_dedupe_key_ux", // GC15 — the dedupe unit
        "notifications_pkey",
        "notifications_ref_idx", // D13 — expire-by-ref on (ref_type, ref_id)
        "notifications_status_next_attempt_idx", // D2 — what the claim's FOR UPDATE SKIP LOCKED scans
        // Plan 11a D7, migration 0016 — the retention prune's index. It is a SEPARATE index from
        // the claim's above and not a widening of it: the claim leads on `next_attempt_at`, the
        // prune on `updated_at`, and one btree cannot lead on both.
        "notifications_status_updated_at_idx",
      ]);
    });
  });

  describe("the three columns beside the table", () => {
    it("defaults patients.promotional_opt_in to FALSE — opt-IN means the patient acted (D9)", async () => {
      const row = (await db.select().from(patients))[0]!;
      expect(row.promotionalOptIn).toBe(false);
      expect(typeof row.promotionalOptIn).toBe("boolean"); // boolean column, not a 't'/'f' string
    });

    it("leaves patients.deceased_at NULL by default and round-trips an instant (D10 / D-33)", async () => {
      expect((await db.select().from(patients))[0]!.deceasedAt).toBeNull();
      const died = new Date("2026-08-20T11:00:00.000Z");
      await db.update(patients).set({ deceasedAt: died });
      expect((await db.select().from(patients))[0]!.deceasedAt).toEqual(died);
    });

    it("leaves users.phone NULL by default and round-trips a normalized 10-digit number", async () => {
      expect((await db.select().from(users))[0]!.phone).toBeNull();
      await db.update(users).set({ phone: "9876543210" });
      expect((await db.select().from(users))[0]!.phone).toBe("9876543210");
    });
  });
});
