import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { H1, actorOf, seedLinenHospital } from "../../../../test/helpers/linen";
import { linenLaundryBatches, linenVariances } from "../../../kernel/db/schema";
import { receiveFromLaundry, recordSoiled, sendToLaundry, topUpWard } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital } from "../../../../test/helpers/linen";

/**
 * DONE MEANS (brief E2.4 (iv)): "laundry short delivery creates a variance". Each item of a batch that comes back short
 * writes one variance row (sent, received, short); an item left out came back as 0; a batch is received once.
 */
describe("acceptance — a short laundry delivery creates a variance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  let batchId: string;
  const now = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
    // A ward returns only what its book holds (PR #752 review): issue first.
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 10 }, { itemCode: "towel", qty: 4 }] }, now);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 10 }, { itemCode: "towel", qty: 4 }] }, now);
    batchId = (await sendToLaundry(db, actorOf(H1), {
      infected: false, lines: [{ itemCode: "bedsheet", qty: 10 }, { itemCode: "towel", qty: 4 }],
    }, now)).batchId!;
  });

  it("8 of 10 bedsheets and no towels back → two variance rows, the batch is short", async () => {
    const r = await receiveFromLaundry(db, actorOf(H1), { batchId, lines: [{ itemCode: "bedsheet", qty: 8 }] }, now);
    expect(r.varianceRecords).toBe(2);
    const rows = await db.select().from(linenVariances).where(eq(linenVariances.batchId, batchId));
    expect(rows.map((v) => [v.itemCode, v.sent, v.received, v.short]).sort()).toEqual([["bedsheet", 10, 8, 2], ["towel", 4, 0, 4]]);
    expect((await db.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.id, batchId)))[0])
      .toMatchObject({ state: "short", piecesReceived: 8 });
    await expect(receiveFromLaundry(db, actorOf(H1), { batchId, lines: [{ itemCode: "towel", qty: 4 }] }, now))
      .rejects.toMatchObject({ code: "already_received" });
  });

  it("everything back → no variance; more than sent is refused", async () => {
    await expect(receiveFromLaundry(db, actorOf(H1), { batchId, lines: [{ itemCode: "bedsheet", qty: 11 }] }, now))
      .rejects.toMatchObject({ code: "more_than_sent" });
    const r = await receiveFromLaundry(db, actorOf(H1), { batchId, lines: [{ itemCode: "bedsheet", qty: 10 }, { itemCode: "towel", qty: 4 }] }, now);
    expect(r.varianceRecords).toBe(0);
    expect(await db.select().from(linenVariances)).toHaveLength(0);
    expect((await db.select().from(linenLaundryBatches))[0]).toMatchObject({ state: "received", piecesReceived: 14 });
  });
});
