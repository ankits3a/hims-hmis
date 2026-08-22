import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events } from "../db/schema";
import {
  EVENTS_DEFAULT_PARTITION,
  EVENT_PARTITION_MONTHS_AHEAD,
  createEventPartitions,
  eventPartitionsFor,
  listEventPartitions,
} from "./partitions";
import type { Db } from "../db/client";

// A month set FAR outside anything migration 0016 or a live clock would create, so the
// create/idempotency tests below start from a known-absent state instead of from whatever the
// per-worker database happens to carry. Dropped again at the end of the file.
const FUTURE = new Date("2031-05-17T06:00:00.000Z");
const FUTURE_NAMES = ["events_2031_05", "events_2031_06", "events_2031_07", "events_2031_08"];

const eventRow = (eventId: string, recordedAt: Date) => ({
  eventId, name: "visit.opened", occurredAt: recordedAt, recordedAt,
  actorType: "system", actorId: "test", module: "opd", payload: { eventId },
});

const partitionOf = async (db: Db): Promise<{ eventId: string; partition: string }[]> =>
  (await db.execute(sql`
    select event_id as "eventId", tableoid::regclass::text as "partition"
    from events order by seq asc
  `)).rows as { eventId: string; partition: string }[];

describe("eventPartitionsFor", () => {
  it("names the CURRENT IST month plus the three ahead, oldest first, with IST bounds", () => {
    // 2026-08-22 11:30 IST. The set is [current, +1, +2, +3] — four names, not three: the
    // current month is in it because a missing current month sends live appends to DEFAULT.
    const set = eventPartitionsFor(new Date("2026-08-22T06:00:00.000Z"));
    expect(EVENT_PARTITION_MONTHS_AHEAD).toBe(3);
    expect(set.map((p) => p.name)).toEqual([
      "events_2026_08", "events_2026_09", "events_2026_10", "events_2026_11",
    ]);
    // Half-open and IST, with the offset spelled out — a UTC boundary would put 5.5 hours of
    // every month-end in the neighbouring partition.
    expect(set[0]).toEqual({
      name: "events_2026_08",
      from: "2026-08-01T00:00:00+05:30",
      to: "2026-09-01T00:00:00+05:30",
    });
    expect(set[3]!.to).toBe("2026-12-01T00:00:00+05:30");
  });

  it("rolls the year over", () => {
    const set = eventPartitionsFor(new Date("2026-11-10T06:00:00.000Z"));
    expect(set.map((p) => p.name)).toEqual([
      "events_2026_11", "events_2026_12", "events_2027_01", "events_2027_02",
    ]);
    expect(set[2]).toEqual({
      name: "events_2027_01",
      from: "2027-01-01T00:00:00+05:30",
      to: "2027-02-01T00:00:00+05:30",
    });
  });

  it("reads the IST calendar and not the UTC one at the boundary", () => {
    // 2026-12-31T19:00:00Z IS 2027-01-01 00:30 IST. A UTC reading would still say December and
    // would leave January uncreated on the one night of the year it matters most.
    const set = eventPartitionsFor(new Date("2026-12-31T19:00:00.000Z"));
    expect(set[0]!.name).toBe("events_2027_01");
  });
});

describe("createEventPartitions", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => {
    for (const name of FUTURE_NAMES) {
      await db.execute(sql.raw(`drop table if exists "${name}"`));
    }
    await teardown();
  });

  // V4 — the Assertion Book row. The killing mutant drops the `if not exists` guard, and the
  // discriminating input is running twice over the same month set.
  it("creates the months ahead, and a SECOND run over the same set is a no-op", async () => {
    for (const name of FUTURE_NAMES) {
      await db.execute(sql.raw(`drop table if exists "${name}"`));
    }
    const before = await listEventPartitions(db);
    expect(before).toEqual(expect.not.arrayContaining(FUTURE_NAMES));

    expect(await createEventPartitions(db, FUTURE)).toEqual(FUTURE_NAMES);
    const afterFirst = await listEventPartitions(db);
    expect(afterFirst).toEqual(expect.arrayContaining(FUTURE_NAMES));

    // The second run is where a guardless implementation raises 42P07 `already exists`. Shipped
    // returns the same names and changes nothing.
    expect(await createEventPartitions(db, FUTURE)).toEqual(FUTURE_NAMES);
    expect(await listEventPartitions(db)).toEqual(afterFirst);
  });

  it("routes a row to its own IST month, and an unpartitioned month to DEFAULT", async () => {
    await createEventPartitions(db, new Date());
    const [current] = eventPartitionsFor(new Date());

    await db.insert(events).values(eventRow("01HPART00000000000CURRENT", new Date()));
    // 2001 has no partition and never will — the DEFAULT one catches it instead of the INSERT
    // failing, which is the whole reason a DEFAULT partition exists on a hospital's write path.
    await db.insert(events).values(eventRow("01HPART000000000000ANCIENT", new Date("2001-01-15T04:30:00.000Z")));

    expect(await partitionOf(db)).toEqual([
      { eventId: "01HPART00000000000CURRENT", partition: current!.name },
      { eventId: "01HPART000000000000ANCIENT", partition: EVENTS_DEFAULT_PARTITION },
    ]);
  });

  it("TRUNCATE on the partitioned PARENT empties every partition and restarts seq", async () => {
    await createEventPartitions(db, new Date());
    const inCurrent = await db.insert(events)
      .values(eventRow("01HPART0000000000TRUNCATE1", new Date()))
      .returning({ seq: events.seq });
    await db.insert(events).values(eventRow("01HPART0000000000TRUNCATE2", new Date("2001-02-15T04:30:00.000Z")));
    expect((await partitionOf(db)).map((r) => r.partition)).toContain(EVENTS_DEFAULT_PARTITION);
    expect(inCurrent[0]!.seq).toBeGreaterThan(0);

    // The helper's statement is unchanged from before partitioning; this is the assertion that
    // it still does both of its jobs against a parent that now owns children.
    await truncateAll(db);

    expect(await partitionOf(db)).toEqual([]);
    const afterRestart = await db.insert(events)
      .values(eventRow("01HPART0000000000TRUNCATE3", new Date()))
      .returning({ seq: events.seq });
    // `restart identity` still reaches `events_seq_seq` — it is OWNED BY the new parent's `seq`
    // column, which is the one line in 0016 that had to precede `drop table events_old`.
    expect(afterRestart[0]!.seq).toBe(1);
  });
});
