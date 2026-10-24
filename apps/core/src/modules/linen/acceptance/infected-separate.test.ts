import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { H1, actorOf, seedLinenHospital } from "../../../../test/helpers/linen";
import { linenLaundryBatches } from "../../../kernel/db/schema";
import { linenBoard, recordInfected, recordSoiled, sendToLaundry, soiledPool, topUpWard } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital } from "../../../../test/helpers/linen";

/**
 * DONE MEANS (brief E2.4 (ii)): "infected linen kept as a separate count and batch". Infected linen is counted apart in
 * the soiled room and leaves only in a batch marked infected; neither pool can be sent in the other's batch.
 */
describe("acceptance — infected linen is its own count and its own batch", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  const now = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
    // A ward returns only what its book holds (PR #752 review): issue first.
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 7 }] }, now);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 5 }] }, now);
    await recordInfected(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
  });

  it("the soiled room holds two counts", async () => {
    expect(await soiledPool(db)).toEqual({ general: { bedsheet: 5 }, infected: { bedsheet: 2 } });
  });

  it("an infected batch takes only infected linen; an ordinary batch only ordinary", async () => {
    await expect(sendToLaundry(db, actorOf(H1), { infected: true, lines: [{ itemCode: "bedsheet", qty: 3 }] }, now))
      .rejects.toMatchObject({ code: "exceeds_soiled" });
    await expect(sendToLaundry(db, actorOf(H1), { infected: false, lines: [{ itemCode: "bedsheet", qty: 6 }] }, now))
      .rejects.toMatchObject({ code: "exceeds_soiled" });
    const inf = await sendToLaundry(db, actorOf(H1), { infected: true, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    const gen = await sendToLaundry(db, actorOf(H1), { infected: false, lines: [{ itemCode: "bedsheet", qty: 5 }] }, now);
    const batches = await db.select().from(linenLaundryBatches);
    expect(batches.find((b) => b.id === inf.batchId)).toMatchObject({ infected: true, piecesSent: 2 });
    expect(batches.find((b) => b.id === gen.batchId)).toMatchObject({ infected: false, piecesSent: 5 });
    expect(await soiledPool(db)).toEqual({ general: {}, infected: {} });
    expect((await db.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.infected, true)))).toHaveLength(1);
  });

  it("the board flags the infected batch and counts its pieces apart", async () => {
    await sendToLaundry(db, actorOf(H1), { infected: true, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    await sendToLaundry(db, actorOf(H1), { infected: false, lines: [{ itemCode: "bedsheet", qty: 5 }] }, now);
    const board = await linenBoard(db, now);
    expect(board.laundryToday).toMatchObject({ outPieces: 7, infectedOutPieces: 2, inPieces: 0 });
    expect(board.inTransit.map((b) => [b.infected, b.piecesSent])).toEqual([[true, 2], [false, 5]]);
  });
});
