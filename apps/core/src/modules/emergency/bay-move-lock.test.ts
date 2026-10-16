import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErWorld } from "../../../test/helpers/emergency";
import { moveBay, placeInBay, registerUnidentified } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — two bay moves that cross zones at once. `move_bay` locks two beds (the new bay, then the old
 * one's release) and every bed lock takes the bed's parent first. Two nurses moving patients in opposite directions
 * between two zones must not deadlock: the beds are locked in one global order (the IPD transfer's `lockBedsInOrder`).
 *
 * The interleaving is made deterministic by holding the lower-id zone from a third connection: Y queues on it holding
 * nothing, X takes its own target zone and queues behind Y; then the zone is let go.
 */
jest.setTimeout(120_000);

const key = (): string => randomUUID();

describe("move_bay — opposite moves between two zones", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const lockWaiters = async (): Promise<number> => {
    const r = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    return Number((r.rows[0] as { n: number }).n);
  };
  const waitFor = async (n: number): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      if ((await lockWaiters()) >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`never saw ${String(n)} lock waiters`);
  };

  it("both moves complete; neither is chosen as a deadlock victim", async () => {
    const low = w.wardId < w.roomId ? "ward" : "room";
    const high = low === "ward" ? "room" : "ward";
    const lowId = low === "ward" ? w.wardId : w.roomId;
    const emergency = { class: "emergency", genderRule: "any" };
    const xFrom = await w.bed("ER-L1", emergency, low);
    const yTo = await w.bed("ER-L2", emergency, low);
    const yFrom = await w.bed("ER-H1", emergency, high);
    const xTo = await w.bed("ER-H2", emergency, high);
    const unknown = () => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" });
    const x = await unknown();
    const y = await unknown();
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: x.episodeId, bedId: xFrom });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: y.episodeId, bedId: yFrom });

    let letGo!: () => void;
    const held = new Promise<void>((r) => { letGo = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction(async (t) => {
      await t.execute(sql`select id from resources where id = ${lowId} for update`);
      locked();
      await held;
    });
    await isLocked;

    const yMove = moveBay(db, w.erNurse, { idempotencyKey: key(), episodeId: y.episodeId, bedId: yTo });
    await waitFor(1);
    const xMove = moveBay(db, w.erNurse, { idempotencyKey: key(), episodeId: x.episodeId, bedId: xTo });
    await waitFor(2);
    letGo();
    await holder;

    const [yr, xr] = await Promise.allSettled([yMove, xMove]);
    expect([yr.status, xr.status, yr.status === "rejected" ? String(yr.reason) : "", xr.status === "rejected" ? String(xr.reason) : ""])
      .toEqual(["fulfilled", "fulfilled", "", ""]);
  });
});
