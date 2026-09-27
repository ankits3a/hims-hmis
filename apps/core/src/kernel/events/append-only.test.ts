import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events } from "../db/schema";
import { EVENTS_DEFAULT_PARTITION } from "../worker/partitions";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-07 — `events` IS APPEND-ONLY AT THE DATABASE, NOT BY CONVENTION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The event log is the audit trail every "who did this, and when" question is answered from, and
 * until this migration nothing below the application stopped a row being edited or removed.
 * A `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger on the partitioned PARENT now raises
 * `audit_append_only`, and Postgres clones a parent's row trigger onto every partition — the ones
 * that existed at migration time AND every month `createEventPartitions` makes afterwards.
 *
 * "The trigger is in pg_trigger" proves nothing (the billing immutability suite's rule), so every
 * row below EXECUTES the statement and observes the raise — through the parent, through the
 * DEFAULT partition, and through a partition created after the migration ran.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED, and pinned here so a later "tightening" cannot break it:
 *   · DROP TABLE of a monthly partition — retention's unit (`retention/sweep.ts` drops a whole
 *     month; it has never deleted an event row). DDL does not fire row triggers.
 *   · TRUNCATE — `truncateAll` between tests. Row triggers do not fire on TRUNCATE either; what
 *     keeps TRUNCATE and DROP away from the API in production is the non-owner database role
 *     (`docs/runbooks/wasa-database-roles.md`), not this trigger.
 */

/** A month no live clock and no other suite creates (partitions.test.ts owns 2031). */
const LATE = { name: "events_2033_03", from: "2033-03-01T00:00:00+05:30", to: "2033-04-01T00:00:00+05:30" };
const IN_LATE = new Date("2033-03-15T06:00:00.000Z");
const ANCIENT = new Date("2001-01-15T04:30:00.000Z"); // no partition, ever → DEFAULT

const APPEND_ONLY = /audit_append_only/;

const eventRow = (eventId: string, recordedAt: Date) => ({
  eventId, name: "visit.opened", occurredAt: recordedAt, recordedAt,
  actorType: "system", actorId: "test", module: "opd", payload: { eventId },
});

describe("WASA M-07 — the event log refuses UPDATE and DELETE", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => {
    await db.execute(sql.raw(`drop table if exists "${LATE.name}"`));
    await teardown();
  });

  it("A1: an UPDATE through the parent is refused, and the row is unchanged", async () => {
    await db.insert(events).values(eventRow("01HAPPENDONLY0000000000001", new Date()));
    await expect(
      db.execute(sql`update events set actor_id = 'somebody-else' where event_id = '01HAPPENDONLY0000000000001'`),
    ).rejects.toThrow(APPEND_ONLY);
    const [row] = await db.select({ actorId: events.actorId }).from(events);
    expect(row!.actorId).toBe("test");
  });

  it("A2: a DELETE through the parent is refused, and the row survives", async () => {
    await db.insert(events).values(eventRow("01HAPPENDONLY0000000000002", new Date()));
    await expect(db.execute(sql`delete from events`)).rejects.toThrow(APPEND_ONLY);
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it("A3: the DEFAULT partition carries the trigger too — addressing the child by name is no way round", async () => {
    await db.insert(events).values(eventRow("01HAPPENDONLY0000000000003", ANCIENT));
    await expect(
      db.execute(sql.raw(`update "${EVENTS_DEFAULT_PARTITION}" set payload = '{}'::jsonb`)),
    ).rejects.toThrow(APPEND_ONLY);
    await expect(db.execute(sql.raw(`delete from "${EVENTS_DEFAULT_PARTITION}"`))).rejects.toThrow(APPEND_ONLY);
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it("A4: a month created AFTER the migration inherits the trigger; DROPPING the month (retention's unit) still works", async () => {
    await db.execute(sql.raw(
      `create table if not exists "${LATE.name}" partition of events for values from ('${LATE.from}') to ('${LATE.to}')`,
    ));
    await db.insert(events).values(eventRow("01HAPPENDONLY0000000000004", IN_LATE));
    const where = await db.execute(sql`select tableoid::regclass::text as p from events`);
    expect((where.rows[0] as { p: string }).p).toBe(LATE.name);

    await expect(db.execute(sql.raw(`delete from "${LATE.name}"`))).rejects.toThrow(APPEND_ONLY);
    await expect(db.execute(sql.raw(`update "${LATE.name}" set name = 'x'`))).rejects.toThrow(APPEND_ONLY);

    // The retention sweep's only way of removing events: the whole month, as DDL.
    await db.execute(sql.raw(`drop table "${LATE.name}"`));
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("A5: TRUNCATE still empties the log — the test harness's reset is not a row delete", async () => {
    await db.insert(events).values(eventRow("01HAPPENDONLY0000000000005", new Date()));
    await db.insert(events).values(eventRow("01HAPPENDONLY0000000000006", ANCIENT));
    await truncateAll(db);
    expect(await db.select().from(events)).toHaveLength(0);
  });
});
