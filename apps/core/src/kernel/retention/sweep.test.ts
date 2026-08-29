import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  eventDeadLetters,
  eventDeliveries,
  eventIdempotency,
  events,
  notifications,
  patients,
  retentionLegalHolds,
} from "../db/schema";
import { listEventPartitions } from "../worker/partitions";
import { registerAllJobs, type JobIntervals } from "../worker/jobs";
import { ModuleRegistry } from "../modules/loader";
import { retentionSweep } from "./sweep";
import type { JobSpec, Scheduler } from "../worker/scheduler";
import type { Db } from "../db/client";

/**
 * RETENTION (Plan 11a D6/D7). Every test in this file drives `retentionSweep` DIRECTLY — the
 * Scheduler is not involved anywhere except the registration block at the bottom, which is about
 * the registration and not about the clock.
 *
 * TIME IS A PARAMETER (Global Constraint 11). `NOW` is pinned and passed; nothing here sleeps,
 * measures a clock, or depends on the real date. The fixture month names are literals chosen
 * against that pin, not against today.
 */
const NOW = new Date("2026-08-22T06:00:00.000Z"); // 2026-08-22 11:30 IST — current IST month 2026-08
const DAY_MS = 24 * 60 * 60_000;
const daysBefore = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

/**
 * The fixture partitions, and every one of them is load-bearing:
 *   · `events_2010_01` / `events_2010_02` — 199 and 198 IST months before the pin, so they are
 *     outside even the shipped 120-month default. These are the months a drop is asserted on.
 *   · `events_2026_06` — TWO months old. Inside the 120-month default (so it must survive an
 *     ordinary run) and outside a one-month window (so it is what V9's non-default value moves).
 *   · `events_2026_08` — the CURRENT month, and `events_2026_09` its neighbour: the two the sweep
 *     must never drop whatever the configuration says.
 * `events_default` is created by migration 0016 and is asserted present after every run.
 */
const ANCIENT = "events_2010_01";
const ANCIENT_2 = "events_2010_02";
const TWO_MONTHS_OLD = "events_2026_06";
const CURRENT = "events_2026_08";
const NEXT = "events_2026_09";
const FIXTURE_PARTITIONS: { name: string; from: string; to: string }[] = [
  { name: ANCIENT, from: "2010-01-01T00:00:00+05:30", to: "2010-02-01T00:00:00+05:30" },
  { name: ANCIENT_2, from: "2010-02-01T00:00:00+05:30", to: "2010-03-01T00:00:00+05:30" },
  { name: TWO_MONTHS_OLD, from: "2026-06-01T00:00:00+05:30", to: "2026-07-01T00:00:00+05:30" },
  { name: CURRENT, from: "2026-08-01T00:00:00+05:30", to: "2026-09-01T00:00:00+05:30" },
  { name: NEXT, from: "2026-09-01T00:00:00+05:30", to: "2026-10-01T00:00:00+05:30" },
];

const IN_ANCIENT = new Date("2010-01-15T06:00:00.000Z");
const IN_ANCIENT_2 = new Date("2010-02-15T06:00:00.000Z");
const IN_TWO_MONTHS_OLD = new Date("2026-06-15T06:00:00.000Z");

const HELD_PATIENT = "01HRETENTIONPATIENTHELD01";
const FREE_PATIENT = "01HRETENTIONPATIENTFREE01";

const eventRow = (eventId: string, recordedAt: Date, patientId?: string) => ({
  eventId,
  name: "visit.opened",
  occurredAt: recordedAt,
  recordedAt,
  actorType: "system",
  actorId: "test",
  module: "opd",
  payload: { eventId },
  patientId,
});

const notificationRow = (
  id: string,
  status: string,
  updatedAt: Date,
): typeof notifications.$inferInsert => ({
  id,
  audience: "patient",
  patientId: FREE_PATIENT,
  templateKey: "patient_welcome",
  params: { uhid: "HMS-00000002-3" },
  dedupeKey: `n:retention:${id}`,
  occurredAt: updatedAt,
  expiresAt: new Date(updatedAt.getTime() + DAY_MS),
  status,
  updatedAt,
});

describe("retentionSweep", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  const partitions = (): Promise<string[]> => listEventPartitions(db);

  const retentionEvents = async (): Promise<{ name: string; payload: unknown }[]> =>
    (await db.execute(sql`
      select name, payload from events
      where name like 'retention.%' or name like 'backup.%'
      order by seq asc
    `)).rows as { name: string; payload: unknown }[];

  const retentionEventsNamed = async (name: string): Promise<{ name: string; payload: unknown }[]> =>
    (await retentionEvents()).filter((e) => e.name === name);

  const notificationIds = async (): Promise<string[]> =>
    (await db.select({ id: notifications.id }).from(notifications).orderBy(notifications.id))
      .map((r) => r.id);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });

  beforeEach(async () => {
    await truncateAll(db);
    for (const p of FIXTURE_PARTITIONS) {
      await db.execute(sql.raw(
        `create table if not exists "${p.name}" partition of events ` +
          `for values from ('${p.from}') to ('${p.to}')`,
      ));
    }
    await db.insert(patients).values([
      {
        id: HELD_PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", administrativeGender: "female",
        phone: "9876500001", createdBy: "u1", updatedBy: "u1",
      },
      {
        id: FREE_PATIENT, uhid: "HMS-00000002-3", name: "Ravi Kumar", sex: "male", administrativeGender: "male",
        phone: "9876500002", createdBy: "u1", updatedBy: "u1",
      },
    ]);
  });

  afterAll(async () => {
    for (const p of FIXTURE_PARTITIONS) {
      await db.execute(sql.raw(`drop table if exists "${p.name}"`));
    }
    await teardown();
  });

  // ---------------------------------------------------------------------------------------------
  // V6 — DISABLED MEANS INERT (Global Constraint 5).
  //
  // THE FIXTURE CARRIES THE ANCIENT DATA ON PURPOSE (§2.49). With an empty fixture "zero drops,
  // zero deletes, zero events" passes under a mutant that ignores the flag entirely, because
  // there was nothing to drop or delete in the first place — the assertion would be vacuous and
  // would look exactly like protection. Everything a fully-enabled run WOULD have destroyed is
  // present here before the call.
  // ---------------------------------------------------------------------------------------------
  describe("RETENTION_ENABLED=false — the mechanism ships inert (V6)", () => {
    beforeEach(async () => {
      await db.insert(events).values([
        eventRow("01HRETENTIONV6ANCIENT00001", IN_ANCIENT, FREE_PATIENT),
        eventRow("01HRETENTIONV6ANCIENT00002", IN_ANCIENT_2, FREE_PATIENT),
      ]);
      await db.insert(notifications).values([
        notificationRow("01HRETENTIONV6NOTIFYSENT01", "sent", daysBefore(400)),
        notificationRow("01HRETENTIONV6NOTIFYEXPD01", "expired", daysBefore(400)),
      ]);
      await db.insert(eventIdempotency).values({
        idempotencyKey: "retention:v6:idem", eventId: "01HRETENTIONV6IDEM00000001",
        seq: 1, recordedAt: IN_ANCIENT,
      });
      await db.insert(eventDeliveries).values({
        consumer: "v6.consumer", seq: 1, status: "done", updatedAt: IN_ANCIENT,
      });
      await db.insert(eventDeadLetters).values({
        consumer: "v6.consumer", seq: 2, eventId: "01HRETENTIONV6DEAD00000001",
        name: "visit.opened", error: "boom", attempts: 5, parkedAt: IN_ANCIENT,
      });
    });

    it("drops nothing, deletes nothing and appends nothing when the flag is false", async () => {
      const before = await partitions();
      expect(before).toEqual(expect.arrayContaining([ANCIENT, ANCIENT_2]));

      const result = await retentionSweep(db, { now: NOW, enabled: false });

      expect(result).toEqual({
        dropped: [], blocked: [], notificationsDeleted: 0,
        idempotencyDeleted: 0, deliveriesDeleted: 0, deadLettersDeleted: 0,
        // Plan 11h T5 — the sweep gained a search-audit leg, and this assertion is the thing that
        // proves the inert gate still covers it: `if (!enabled) return inert()` is the first
        // statement in the function, so a new leg added BELOW it cannot delete anything while the
        // flag is false. Global Constraint 5 holds for the new leg by construction, and this line
        // is what would notice if a later leg were ever added above the gate.
        searchAuditDeleted: 0,
        // PLAN 07a T2 — the PHI access-log leg, and this line is the assertion doing its job: the
        // exact-shape `toEqual` is what forced this file to be edited when a leg was added, which
        // is exactly the visibility it exists for. Same reasoning as above — the leg sits BELOW the
        // inert gate, so it deletes nothing while the flag is false.
        phiAccessDeleted: 0,
      });
      expect(await partitions()).toEqual(before);
      expect(await notificationIds()).toEqual([
        "01HRETENTIONV6NOTIFYEXPD01", "01HRETENTIONV6NOTIFYSENT01",
      ]);
      expect(await db.select().from(eventIdempotency)).toHaveLength(1);
      expect(await db.select().from(eventDeliveries)).toHaveLength(1);
      expect(await db.select().from(eventDeadLetters)).toHaveLength(1);
      expect(await retentionEvents()).toEqual([]);
    });

    // The DEFAULT is the same answer as the explicit false: a caller that says nothing at all
    // gets the inert sweep, so forgetting to thread the key can never enable retention.
    it("is inert when `enabled` is not passed at all — the default is false, not 'unset'", async () => {
      const before = await partitions();

      const result = await retentionSweep(db, { now: NOW });

      expect(result.dropped).toEqual([]);
      expect(result.notificationsDeleted).toBe(0);
      expect(await partitions()).toEqual(before);
      expect(await retentionEvents()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // The drops themselves.
  // ---------------------------------------------------------------------------------------------
  describe("partition drops", () => {
    beforeEach(async () => {
      await db.insert(events).values([
        eventRow("01HRETENTIONDROPANCIENT001", IN_ANCIENT, FREE_PATIENT),
        eventRow("01HRETENTIONDROPANCIENT002", IN_ANCIENT, FREE_PATIENT),
        eventRow("01HRETENTIONDROPANCIENT2_1", IN_ANCIENT_2, FREE_PATIENT),
        eventRow("01HRETENTIONDROPRECENT0001", IN_TWO_MONTHS_OLD, FREE_PATIENT),
      ]);
    });

    it("drops the months outside the window, keeps everything inside it, and events each drop", async () => {
      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      expect(result.dropped).toEqual([ANCIENT, ANCIENT_2]);
      expect(result.blocked).toEqual([]);
      const after = await partitions();
      expect(after).not.toContain(ANCIENT);
      expect(after).not.toContain(ANCIENT_2);
      // Inside the window, and the two the configuration may never reach.
      expect(after).toEqual(expect.arrayContaining([TWO_MONTHS_OLD, CURRENT, NEXT]));

      const appended = await retentionEvents();
      expect(appended.map((e) => e.name)).toEqual([
        "retention.partition_dropped", "retention.partition_dropped",
      ]);
      // The row count is read INSIDE the dropping transaction: after the drop nothing else can
      // answer how much was destroyed.
      expect(appended[0]!.payload).toEqual({
        partition: ANCIENT, month: "2010-01", rows: 2, retainedMonths: 120,
      });
      expect(appended[1]!.payload).toEqual({
        partition: ANCIENT_2, month: "2010-02", rows: 1, retainedMonths: 120,
      });
    });

    // GC5's second half, and it does not consult the window at all: a misconfigured one-month
    // window must not reach the month live traffic is being written into, nor yesterday's.
    it("never drops the DEFAULT partition or the current/adjacent months, whatever the window says", async () => {
      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 1 });

      const after = await partitions();
      expect(after).toEqual(expect.arrayContaining([CURRENT, NEXT]));
      expect(result.dropped).not.toContain(CURRENT);
      expect(result.dropped).not.toContain(NEXT);
      // `listEventPartitions` excludes the DEFAULT one by design, so it is read straight from the
      // catalogue here rather than through the helper that would hide its absence.
      const [def] = (await db.execute(sql`
        select c.relname as "name" from pg_class c where c.relname = 'events_default'
      `)).rows as { name: string }[];
      expect(def?.name).toBe("events_default");
    });
  });

  // ---------------------------------------------------------------------------------------------
  // V5 / FLAG ⑥ — A HELD MONTH IS UNDROPPABLE. A dropped held month is a legal record gone.
  // ---------------------------------------------------------------------------------------------
  describe("legal holds (V5, flag ⑥)", () => {
    beforeEach(async () => {
      await db.insert(events).values([
        eventRow("01HRETENTIONHELDEVENT00001", IN_ANCIENT, HELD_PATIENT),
        eventRow("01HRETENTIONFREEEVENT00001", IN_ANCIENT_2, FREE_PATIENT),
      ]);
    });

    it("keeps a month containing an event of a patient under an ACTIVE hold, and events the refusal", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONHOLDPATIENT001", patientId: HELD_PATIENT,
        reason: "Sharma v. hospital — preserve this patient's record", createdBy: "u1",
      });

      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      expect(result.blocked).toEqual([ANCIENT]);
      expect(result.dropped).toEqual([ANCIENT_2]); // the un-held month still goes — the hold is per month, not global
      expect(await partitions()).toContain(ANCIENT);

      const appended = await retentionEvents();
      expect(appended.map((e) => e.name)).toEqual([
        "retention.drop_blocked", "retention.partition_dropped",
      ]);
      expect(appended[0]!.payload).toEqual({
        partition: ANCIENT,
        month: "2010-01",
        reason: "legal_hold_patient",
        holdId: "01HRETENTIONHOLDPATIENT001",
      });
    });

    it("an ACTIVE GLOBAL hold (null patient_id) blocks every month", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONHOLDGLOBAL0001", patientId: null,
        reason: "commission of inquiry — preserve everything", createdBy: "u1",
      });

      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      expect(result.dropped).toEqual([]);
      expect(result.blocked).toEqual([ANCIENT, ANCIENT_2]);
      expect(await partitions()).toEqual(expect.arrayContaining([ANCIENT, ANCIENT_2]));
      const appended = await retentionEvents();
      expect(appended.map((e) => e.name)).toEqual([
        "retention.drop_blocked", "retention.drop_blocked",
      ]);
      expect((appended[0]!.payload as { reason: string }).reason).toBe("legal_hold_global");
    });

    /**
     * THE OTHER HALF, and without it the two tests above cannot tell a working hold check from a
     * check that refuses everything. A hold is RELEASED, never deleted (schema/retention.ts), so
     * `released_at` is the only thing that distinguishes the two states — and it is the state a
     * hold spends most of its life in once the matter closes.
     */
    it("a RELEASED hold does not block: retention resumes on the month it was protecting", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONHOLDRELEASED01", patientId: HELD_PATIENT,
        reason: "matter closed", releasedAt: new Date("2026-01-01T00:00:00.000Z"), createdBy: "u1",
      });
      // ... and a GLOBAL hold that is also released, so neither leg of the check can be the one
      // silently doing the work.
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONHOLDRELGLOBAL1", patientId: null,
        reason: "inquiry closed", releasedAt: new Date("2026-02-01T00:00:00.000Z"), createdBy: "u1",
      });

      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      expect(result.blocked).toEqual([]);
      expect(result.dropped).toEqual([ANCIENT, ANCIENT_2]);
    });

    // A hold on a patient with no events in the ancient month protects nothing there: the check
    // is against the month's OWN rows, not against the existence of a hold somewhere.
    it("a hold on an unrelated patient does not protect a month that holds none of their events", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONHOLDOTHERPAT01", patientId: FREE_PATIENT,
        reason: "unrelated matter", createdBy: "u1",
      });

      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      // ANCIENT holds only HELD_PATIENT's event, ANCIENT_2 only FREE_PATIENT's — so exactly one
      // month is protected, and it is the one whose rows the hold actually names.
      expect(result.dropped).toEqual([ANCIENT]);
      expect(result.blocked).toEqual([ANCIENT_2]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // D7 — the notifications prune.
  // ---------------------------------------------------------------------------------------------
  describe("notifications prune (D7)", () => {
    // V7 — GLOBAL CONSTRAINT 6. `queued` and `sending` are never pruned at any age.
    it("never prunes a queued or sending row, at any age, while terminal rows of the same age go", async () => {
      await db.insert(notifications).values([
        notificationRow("01HRETENTIONV7QUEUED000001", "queued", daysBefore(2000)),
        notificationRow("01HRETENTIONV7SENDING00001", "sending", daysBefore(2000)),
        notificationRow("01HRETENTIONV7SENT0000001", "sent", daysBefore(2000)),
      ]);

      const result = await retentionSweep(db, { now: NOW, enabled: true, notifyRetainDays: 180 });

      // The terminal row of the SAME age going is what makes the two survivals meaningful: this
      // run really did prune, and it still left these two alone.
      expect(result.notificationsDeleted).toBe(1);
      expect(await notificationIds()).toEqual([
        "01HRETENTIONV7QUEUED000001", "01HRETENTIONV7SENDING00001",
      ]);
    });

    /**
     * V8 (a pre-declared P row) — the boundary. Two `sent` rows one day each side of the
     * 180-day window: the older goes, the younger stays. The Book's own stated input is used
     * unchanged; both legs discriminate (the mutant that flips the comparison fails both).
     */
    it("deletes a terminal row one day OUTSIDE the window and keeps one a day INSIDE it", async () => {
      await db.insert(notifications).values([
        notificationRow("01HRETENTIONV8OUTSIDE00001", "sent", daysBefore(181)),
        notificationRow("01HRETENTIONV8INSIDE000001", "sent", daysBefore(179)),
      ]);

      const result = await retentionSweep(db, { now: NOW, enabled: true, notifyRetainDays: 180 });

      expect(result.notificationsDeleted).toBe(1);
      expect(await notificationIds()).toEqual(["01HRETENTIONV8INSIDE000001"]);
    });

    it("prunes all four terminal statuses and events ONE row with the count, not one per row", async () => {
      await db.insert(notifications).values([
        notificationRow("01HRETENTIONPRUNESENT00001", "sent", daysBefore(400)),
        notificationRow("01HRETENTIONPRUNEEXPIRED01", "expired", daysBefore(400)),
        notificationRow("01HRETENTIONPRUNESUPPRES01", "suppressed", daysBefore(400)),
        notificationRow("01HRETENTIONPRUNEUNDELIV01", "undeliverable", daysBefore(400)),
      ]);

      const result = await retentionSweep(db, { now: NOW, enabled: true, notifyRetainDays: 180 });

      expect(result.notificationsDeleted).toBe(4);
      expect(await notificationIds()).toEqual([]);
      // Filtered by name because the fixture partitions are ancient and this run is enabled, so
      // the same sweep legitimately drops them too and events each drop. ONE row for FOUR deleted
      // notifications is the claim, and this is where it is made.
      const appended = await retentionEventsNamed("retention.notifications_pruned");
      expect(appended).toHaveLength(1);
      expect(appended[0]!.payload).toEqual({
        deleted: 4,
        batches: 1,
        retainDays: 180,
        cutoff: daysBefore(180).toISOString(),
      });
    });

    it("deletes in BOUNDED BATCHES — five doomed rows at a batch size of two is three statements", async () => {
      await db.insert(notifications).values(
        [1, 2, 3, 4, 5].map((n) =>
          notificationRow(`01HRETENTIONBATCH00000000${n}`, "sent", daysBefore(400)),
        ),
      );

      const result = await retentionSweep(db, {
        now: NOW, enabled: true, notifyRetainDays: 180, batchSize: 2,
      });

      expect(result.notificationsDeleted).toBe(5);
      expect(await notificationIds()).toEqual([]);
      const appended = await retentionEventsNamed("retention.notifications_pruned");
      expect(appended).toHaveLength(1);
      // 2 + 2 + 1: the third statement returns fewer rows than the batch size and ends the loop.
      expect(appended[0]!.payload).toEqual(expect.objectContaining({ deleted: 5, batches: 3 }));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // V12 — THE COMPANION SWEEP. A partition drop orphans these three tables (no FKs, by design),
  // which is how the growth problem moves one table over without anybody noticing.
  // ---------------------------------------------------------------------------------------------
  describe("the companion sweep over the side tables (V12)", () => {
    beforeEach(async () => {
      await db.insert(eventIdempotency).values([
        { idempotencyKey: "retention:v12:ancient", eventId: "01HRETENTIONV12IDEMOLD0001", seq: 1, recordedAt: IN_ANCIENT },
        { idempotencyKey: "retention:v12:fresh", eventId: "01HRETENTIONV12IDEMNEW0001", seq: 2, recordedAt: daysBefore(1) },
      ]);
      await db.insert(eventDeliveries).values([
        { consumer: "v12.consumer", seq: 1, status: "done", updatedAt: IN_ANCIENT },
        { consumer: "v12.consumer", seq: 2, status: "retrying", updatedAt: IN_ANCIENT, attempts: 3 },
        { consumer: "v12.consumer", seq: 3, status: "parked", updatedAt: IN_ANCIENT },
        { consumer: "v12.consumer", seq: 4, status: "done", updatedAt: daysBefore(1) },
      ]);
      await db.insert(eventDeadLetters).values([
        { consumer: "v12.consumer", seq: 5, eventId: "01HRETENTIONV12DEADOLD0001", name: "visit.opened", error: "boom", attempts: 5, parkedAt: IN_ANCIENT },
        { consumer: "v12.consumer", seq: 6, eventId: "01HRETENTIONV12DEADNEW0001", name: "visit.opened", error: "boom", attempts: 5, parkedAt: daysBefore(1) },
      ]);
    });

    it("deletes only rows outside the window, and NEVER a retrying delivery at any age", async () => {
      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      expect(result.idempotencyDeleted).toBe(1);
      expect(result.deliveriesDeleted).toBe(2); // the ancient done and the ancient parked
      expect(result.deadLettersDeleted).toBe(1);

      expect((await db.select().from(eventIdempotency)).map((r) => r.idempotencyKey))
        .toEqual(["retention:v12:fresh"]);
      // The ancient RETRYING row is still owed to its consumer; age says only that it has been
      // failing for a long time.
      expect((await db.select().from(eventDeliveries).orderBy(eventDeliveries.seq))
        .map((r) => ({ seq: r.seq, status: r.status })))
        .toEqual([{ seq: 2, status: "retrying" }, { seq: 4, status: "done" }]);
      expect((await db.select().from(eventDeadLetters)).map((r) => r.seq)).toEqual([6]);
    });

    it("events the three counts ONCE per run", async () => {
      await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      const appended = (await retentionEvents()).filter((e) => e.name === "retention.side_tables_pruned");
      expect(appended).toHaveLength(1);
      expect(appended[0]!.payload).toEqual({
        eventIdempotency: 1,
        eventDeliveries: 2,
        eventDeadLetters: 1,
        retainedMonths: 120,
        cutoff: new Date("2016-08-01T00:00:00+05:30").toISOString(),
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // §7.2 — THE HOLD REACHES THE SIDE TABLES. THIS BLOCK IS THE COMPOSITION, AND THE COMPOSITION
  // IS THE POINT.
  //
  // V5's fixture carries a hold and NO side-table rows. V12's carries side-table rows and NO
  // hold. Both were correct, both passed, and the defect lived in the gap between them: the sweep
  // saved the held month's `events` partition, evented `retention.drop_blocked`, and in the SAME
  // RUN deleted that month's idempotency, delivery and dead-letter rows. Two disjoint fixture
  // worlds, so no mutant either of them could build ever reached the composition (§2.57) — which
  // is why every fixture below carries BOTH conditions at once, with the sweep ENABLED.
  //
  // THE UN-HELD MONTH OLDER THAN THE HELD ONE IS LOAD-BEARING IN THE OTHER DIRECTION (§2.49).
  // Without it, "the held rows survived" would pass just as well under a sweep that had stopped
  // pruning side tables altogether, and the assertion would be measuring an outage rather than a
  // hold. Its rows must still go, and the released-hold case below is the same discipline again:
  // a clamp that always clamps is not a hold check.
  // ---------------------------------------------------------------------------------------------
  describe("a legal hold governs the companion sweep too (gate report §7.2)", () => {
    /** 2009-12 — OLDER than the held month, held by nothing, and no partition of its own. */
    const BEFORE_HELD = new Date("2009-12-15T06:00:00.000Z");

    beforeEach(async () => {
      await db.insert(events).values([
        // The hold's anchor: one event of the held patient, inside ANCIENT (2010-01).
        eventRow("01HRETENTIONS72HELDEVENT01", IN_ANCIENT, HELD_PATIENT),
        // ANCIENT_2 (2010-02) is nobody's held month, so it is still dropped — that is what keeps
        // an "enabled" run from being indistinguishable from an inert one.
        eventRow("01HRETENTIONS72FREEEVENT01", IN_ANCIENT_2, FREE_PATIENT),
      ]);
      await db.insert(eventIdempotency).values([
        {
          idempotencyKey: "retention:s72:held", eventId: "01HRETENTIONS72IDEMHELD001",
          seq: 1, recordedAt: IN_ANCIENT,
        },
        {
          idempotencyKey: "retention:s72:older", eventId: "01HRETENTIONS72IDEMOLDER01",
          seq: 2, recordedAt: BEFORE_HELD,
        },
      ]);
      await db.insert(eventDeliveries).values([
        { consumer: "s72.consumer", seq: 1, status: "done", updatedAt: IN_ANCIENT },
        { consumer: "s72.consumer", seq: 2, status: "parked", updatedAt: IN_ANCIENT },
        { consumer: "s72.consumer", seq: 3, status: "done", updatedAt: BEFORE_HELD },
      ]);
      await db.insert(eventDeadLetters).values([
        {
          consumer: "s72.consumer", seq: 4, eventId: "01HRETENTIONS72DEADHELD01",
          name: "visit.opened", error: "boom", attempts: 5, parkedAt: IN_ANCIENT,
        },
        {
          consumer: "s72.consumer", seq: 5, eventId: "01HRETENTIONS72DEADOLDER1",
          name: "visit.opened", error: "boom", attempts: 5, parkedAt: BEFORE_HELD,
        },
      ]);
      // D7's table, present in every case here so each one can also state what a hold does NOT
      // do: the outbox prune is a different window on a different table and is untouched.
      await db.insert(notifications).values([
        notificationRow("01HRETENTIONS72NOTIFYOLD01", "sent", daysBefore(400)),
        notificationRow("01HRETENTIONS72NOTIFYNEW01", "sent", daysBefore(2)),
      ]);
    });

    it("a PATIENT hold keeps the held month's idempotency, delivery and dead-letter rows, not just its events", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONS72HOLDPATIENT", patientId: HELD_PATIENT,
        reason: "Sharma v. hospital — preserve this patient's record", createdBy: "u1",
      });

      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      // The partition half is UNCHANGED: the held month survives, the un-held one goes.
      expect(result.blocked).toEqual([ANCIENT]);
      expect(result.dropped).toEqual([ANCIENT_2]);
      expect(await partitions()).toContain(ANCIENT);

      // ...and here is the half that was missing. Every side-table row IN the held month lives.
      expect(
        (await db.select().from(eventIdempotency).orderBy(eventIdempotency.idempotencyKey))
          .map((r) => r.idempotencyKey),
      ).toEqual(["retention:s72:held"]);
      expect(
        (await db.select().from(eventDeliveries).orderBy(eventDeliveries.seq))
          .map((r) => ({ seq: r.seq, status: r.status })),
      ).toEqual([{ seq: 1, status: "done" }, { seq: 2, status: "parked" }]);
      expect(
        (await db.select().from(eventDeadLetters).orderBy(eventDeadLetters.seq)).map((r) => r.seq),
      ).toEqual([4]);

      // The month BEFORE the held one is protected by nothing and still goes — one row from each
      // table. The hold moved the cutoff; it did not switch the companion sweep off.
      expect(result.idempotencyDeleted).toBe(1);
      expect(result.deliveriesDeleted).toBe(1);
      expect(result.deadLettersDeleted).toBe(1);

      // D7 is not patient-event-scoped and a hold does not reach it (the note above step 3).
      expect(result.notificationsDeleted).toBe(1);
      expect(await notificationIds()).toEqual(["01HRETENTIONS72NOTIFYNEW01"]);
    });

    // The clamped instant is EVENTED, so an auditor reading the stream can see which run was
    // shortened by a hold instead of inferring it from a count that happens to be low.
    it("events the companion counts against the CLAMPED cutoff, not the window's", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONS72HOLDCUTOFF0", patientId: HELD_PATIENT,
        reason: "Sharma v. hospital — preserve this patient's record", createdBy: "u1",
      });

      await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      const appended = await retentionEventsNamed("retention.side_tables_pruned");
      expect(appended).toHaveLength(1);
      expect(appended[0]!.payload).toEqual({
        eventIdempotency: 1,
        eventDeliveries: 1,
        eventDeadLetters: 1,
        retainedMonths: 120,
        // NOT 2016-08-01, which is where the 120-month window alone would have put it: the first
        // of the HELD month, because the month is the retention unit.
        cutoff: new Date("2010-01-01T00:00:00+05:30").toISOString(),
      });
    });

    it("an ACTIVE GLOBAL hold makes the companion sweep a no-op — 'preserve everything' includes the trail", async () => {
      await db.insert(retentionLegalHolds).values({
        id: "01HRETENTIONS72HOLDGLOBAL0", patientId: null,
        reason: "commission of inquiry — preserve everything from this period", createdBy: "u1",
      });

      const result = await retentionSweep(db, {
        now: NOW, enabled: true, eventsMonths: 120, notifyRetainDays: 180,
      });

      expect(result.dropped).toEqual([]);
      expect(result.blocked).toEqual([ANCIENT, ANCIENT_2]);
      expect(result.idempotencyDeleted).toBe(0);
      expect(result.deliveriesDeleted).toBe(0);
      expect(result.deadLettersDeleted).toBe(0);
      // Including the 2009-12 rows, which NO partition protects — a global hold is not "every
      // month that happens to have a partition the loop looked at", it is every month.
      expect(await db.select().from(eventIdempotency)).toHaveLength(2);
      expect(await db.select().from(eventDeliveries)).toHaveLength(3);
      expect(await db.select().from(eventDeadLetters)).toHaveLength(2);
      expect(await retentionEventsNamed("retention.side_tables_pruned")).toEqual([]);

      // AND THE RUN WAS LIVE, not inert: the outbox prune still ran. D7 is deliberately outside
      // the hold — a different window on a different table. If counsel ever rules that a global
      // hold must suspend the outbox too, THIS is the assertion that has to change, and that is
      // the point of asserting it.
      expect(result.notificationsDeleted).toBe(1);
      expect(await notificationIds()).toEqual(["01HRETENTIONS72NOTIFYNEW01"]);
    });

    /**
     * THE OTHER HALF, and without it a clamp that always clamps would pass every test above. A
     * hold is RELEASED, never deleted, so `released_at` is the only thing separating the two
     * states — and both legs are released here, so neither can be the one silently doing nothing.
     */
    it("a RELEASED hold does not clamp: the whole window's trail goes, held month included", async () => {
      await db.insert(retentionLegalHolds).values([
        {
          id: "01HRETENTIONS72RELPATIENT", patientId: HELD_PATIENT, reason: "matter closed",
          releasedAt: new Date("2026-01-01T00:00:00.000Z"), createdBy: "u1",
        },
        {
          id: "01HRETENTIONS72RELGLOBAL0", patientId: null, reason: "inquiry closed",
          releasedAt: new Date("2026-02-01T00:00:00.000Z"), createdBy: "u1",
        },
      ]);

      const result = await retentionSweep(db, { now: NOW, enabled: true, eventsMonths: 120 });

      expect(result.blocked).toEqual([]);
      expect(result.dropped).toEqual([ANCIENT, ANCIENT_2]);
      expect(result.idempotencyDeleted).toBe(2);
      expect(result.deliveriesDeleted).toBe(3);
      expect(result.deadLettersDeleted).toBe(2);
      expect(await db.select().from(eventIdempotency)).toEqual([]);
      expect(await db.select().from(eventDeliveries)).toEqual([]);
      expect(await db.select().from(eventDeadLetters)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // GLOBAL CONSTRAINT 14 / BOOK V9 — THE CONFIG REACHES THE SWEEP THROUGH THE PRODUCTION
  // REGISTRATION, and this is the only block in the file that goes through `registerAllJobs`.
  //
  // This is the `NOTIFY_STUCK_AFTER_MS` scar's shape (jobs.test.ts, Book R2): a key that parsed,
  // was asserted to parse, and reached nothing. `config.test.ts` asserting these three parse is
  // NOT protection — so each of them is registered here with a value that is NOT its default and
  // the sweep's BEHAVIOUR is asserted to differ from what the default would have produced.
  // ---------------------------------------------------------------------------------------------
  describe("the retention config reaches the sweep through the PRODUCTION registration (V9, GC14)", () => {
    /**
     * `Scheduler` is a class with `private` members and is therefore compared NOMINALLY, so a
     * structural recorder needs this cast (§2.61) — the same recorder `jobs.test.ts` uses for R2.
     * `registerAllJobs` itself is the real production function; that is what is under test.
     */
    function recordingScheduler(specs: JobSpec[]): Scheduler {
      return {
        register(spec: JobSpec): void {
          specs.push(spec);
        },
      } as unknown as Scheduler;
    }

    const INTERVALS = (retention: Pick<
      JobIntervals,
      "retentionEnabled" | "retentionEventsMonths" | "notifyRetainDays"
    >): JobIntervals => ({
      workerDispatchIntervalMs: 2000,
      workerTimersIntervalMs: 20_000,
      workerTempRolesIntervalMs: 60_000,
      workerNotifyIntervalMs: 5000,
      notifyStuckAfterMs: 300_000,
      // Plan 11c D6: the TENTH job's cadence. Present here for one reason and no other — widening
      // the `JobIntervals` Pick in `worker/jobs.ts` stopped this literal compiling until it carried
      // the key, exactly as that Pick's own comment promises. THE SHIPPED DEFAULT, PASSED
      // EXPLICITLY: nothing in this file registers, runs or observes the interface sweep, and
      // nothing about retention's semantics changes because of it (plan GC4).
      workerInterfaceSweepIntervalMs: 60_000,
      workerLabSweepIntervalMs: 60_000,
      ...retention,
    });

    const registeredSweep = (intervals: JobIntervals): JobSpec => {
      const specs: JobSpec[] = [];
      registerAllJobs(recordingScheduler(specs), db, new ModuleRegistry(), {}, intervals);
      const spec = specs.find((s) => s.name === "retentionSweep");
      if (spec === undefined) throw new Error("registerAllJobs registered no retentionSweep job");
      return spec;
    };

    beforeEach(async () => {
      await db.insert(events).values([
        eventRow("01HRETENTIONV9ANCIENT00001", IN_ANCIENT, FREE_PATIENT),
        eventRow("01HRETENTIONV9RECENT000001", IN_TWO_MONTHS_OLD, FREE_PATIENT),
      ]);
      await db.insert(notifications).values([
        notificationRow("01HRETENTIONV9SENT00000001", "sent", daysBefore(2)),
      ]);
    });

    it("registers the sweep at 01:15 IST as the ninth job", () => {
      const spec = registeredSweep(
        INTERVALS({ retentionEnabled: false, retentionEventsMonths: 120, notifyRetainDays: 180 }),
      );
      expect(spec).toEqual(
        expect.objectContaining({ name: "retentionSweep", dailyIst: "01:15" }),
      );
    });

    it("RETENTION_ENABLED reaches it: registered false the ancient month survives, registered true it goes", async () => {
      await registeredSweep(
        INTERVALS({ retentionEnabled: false, retentionEventsMonths: 120, notifyRetainDays: 180 }),
      ).run(NOW);
      expect(await partitions()).toContain(ANCIENT);

      await registeredSweep(
        INTERVALS({ retentionEnabled: true, retentionEventsMonths: 120, notifyRetainDays: 180 }),
      ).run(NOW);
      expect(await partitions()).not.toContain(ANCIENT);
    });

    it("RETENTION_EVENTS_MONTHS reaches it: at 1 the two-month-old partition goes, at the 120 default it does not", async () => {
      await registeredSweep(
        INTERVALS({ retentionEnabled: true, retentionEventsMonths: 120, notifyRetainDays: 180 }),
      ).run(NOW);
      // Reachable only through the registered value: at 120 months a June partition is nowhere
      // near the window, and at 1 month it is two months outside it.
      expect(await partitions()).toContain(TWO_MONTHS_OLD);

      await registeredSweep(
        INTERVALS({ retentionEnabled: true, retentionEventsMonths: 1, notifyRetainDays: 180 }),
      ).run(NOW);
      expect(await partitions()).not.toContain(TWO_MONTHS_OLD);
    });

    it("NOTIFY_RETAIN_DAYS reaches it: at 1 a two-day-old sent row goes, at the 180 default it stays", async () => {
      await registeredSweep(
        INTERVALS({ retentionEnabled: true, retentionEventsMonths: 120, notifyRetainDays: 180 }),
      ).run(NOW);
      expect(await notificationIds()).toEqual(["01HRETENTIONV9SENT00000001"]);

      await registeredSweep(
        INTERVALS({ retentionEnabled: true, retentionEventsMonths: 120, notifyRetainDays: 1 }),
      ).run(NOW);
      expect(await notificationIds()).toEqual([]);
    });
  });
});
