import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { H1, SUPA, SUPB, actorOf, hoursFrom, seedLinenHospital } from "../../../test/helpers/linen";
import { linenMovements, linenWardCounts } from "../../kernel/db/schema";
import {
  approveCondemn, borrowBetweenWards, recordInfected, recordSoiled, recordWardCount, requestCondemn, topUpWard, wardStates,
  weeklyVariance,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { Pool } from "pg";
import type { LinenHospital } from "../../../test/helpers/linen";

/** PR #752 review findings — each red against the code before its fix. */
jest.setTimeout(30_000);

describe("linen — PR #752 review", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  const line = (itemCode: string, qty: number) => ({ lines: [{ itemCode, qty }] });

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
  });

  it("1. an act with no instant given is stamped AFTER it got the ward lock, not when it was called", async () => {
    const holder = await pool.connect();
    let released: number;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext($1))", [`linen:ward:${h.generalWard}`]);
      const act = topUpWard(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 3) });
      await new Promise((r) => setTimeout(r, 400));
      released = Date.now();
      await holder.query("commit");
      await act;
    } finally {
      holder.release();
    }
    const [m] = await db.select().from(linenMovements);
    expect(m!.at.getTime()).toBeGreaterThanOrEqual(released! - 50);
  });

  it("2. soiled and infected returns cannot exceed the ward's book balance", async () => {
    const now = new Date();
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 3) }, now);
    await expect(recordSoiled(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 4) }, now))
      .rejects.toMatchObject({ code: "exceeds_on_hand", details: { itemCode: "towel", onHand: 3 } });
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 2) }, now);
    await expect(recordInfected(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 2) }, now))
      .rejects.toMatchObject({ code: "exceeds_on_hand" });
  });

  it("3. a ward cannot lend more than it holds", async () => {
    const now = new Date();
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, ...line("blanket", 2) }, now);
    await expect(borrowBetweenWards(db, actorOf(H1), { fromWardId: h.generalWard, toWardId: h.icuWard, ...line("blanket", 3) }, now))
      .rejects.toMatchObject({ code: "exceeds_on_hand", details: { itemCode: "blanket", onHand: 2 } });
  });

  it("4. an approval cannot write off more than the ward still holds", async () => {
    const now = new Date();
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, ...line("bedsheet", 3) }, now);
    const req = await requestCondemn(db, actorOf(SUPA), { wardId: h.generalWard, itemCode: "bedsheet", qty: 3, reason: "torn" }, now);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, ...line("bedsheet", 2) }, now);
    await expect(approveCondemn(db, actorOf(SUPB), { requestId: req.id }, now)).rejects.toMatchObject({ code: "exceeds_on_hand" });
    expect((await db.select().from(linenMovements)).filter((m) => m.kind === "condemn")).toHaveLength(0);
  });

  it("5. a count key reused with different counts is refused; the same counts again are one count", async () => {
    const now = new Date();
    const key = "count-key-0001";
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 5 }], idempotencyKey: key }, now);
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 5 }], idempotencyKey: key }, now);
    await expect(recordWardCount(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 6 }], idempotencyKey: key }, now))
      .rejects.toMatchObject({ code: "key_reused" });
    expect(await db.select().from(linenWardCounts)).toHaveLength(1);
  });

  it("6. a movement at exactly the count's instant is AFTER the count, in the balance and in the variance alike", async () => {
    const to = new Date();
    const from = hoursFrom(to, -7 * 24);
    const tc = hoursFrom(to, -2);
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 10) }, tc);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 2) }, tc);
    const onHand = (await wardStates(db, to, h.generalWard))[0]!.items.find((i) => i.itemCode === "towel")!.onHand;
    expect(onHand).toBe(8);
    // That soiled return is after the closing count: not this window's loss.
    expect(await weeklyVariance(db, from, to)).toEqual([expect.objectContaining({ itemCode: "towel", opening: 0, issued: 0, returned: 0, counted: 10, missing: -10 })]);
  });
});
