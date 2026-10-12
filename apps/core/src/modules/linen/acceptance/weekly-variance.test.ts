import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { H1, actorOf, hoursFrom, seedLinenHospital } from "../../../../test/helpers/linen";
import { borrowBetweenWards, recordInfected, recordSoiled, recordWardCount, topUpWard, weeklyVariance } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital } from "../../../../test/helpers/linen";

/**
 * DONE MEANS (brief E2.4 (iii)): "weekly loss variance computed from records". missing = opening count + issued
 * (store + borrowed in) − returned (soiled + infected + borrowed out + condemned) − the last count in the week; with no
 * earlier count that is exactly issued − (soiled + infected + on hand by last count). The window is the test's own.
 */
describe("acceptance — weekly loss variance from the records", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  let from: Date;
  let to: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
    to = new Date();
    from = hoursFrom(to, -7 * 24);
  });

  const line = (itemCode: string, qty: number) => ({ lines: [{ itemCode, qty }] });

  it("no earlier count: issued 26, soiled 6, counted 18 → 2 missing", async () => {
    await topUpWard(db, actorOf(H1), { wardId: h.mixedWard, ...line("bedsheet", 26) }, hoursFrom(from, 1));
    await recordSoiled(db, actorOf(H1), { wardId: h.mixedWard, ...line("bedsheet", 6) }, hoursFrom(from, 30));
    await recordWardCount(db, actorOf(H1), { wardId: h.mixedWard, ...line("bedsheet", 18) }, hoursFrom(to, -2));
    expect(await weeklyVariance(db, from, to)).toEqual([expect.objectContaining({
      wardId: h.mixedWard, itemCode: "bedsheet", opening: 0, issued: 26, returned: 6, counted: 18, missing: 2,
    })]);
  });

  it("opening count before the week, infected and borrowed out are returns, later movements are next week's", async () => {
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 20) }, hoursFrom(from, -1));
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 10) }, hoursFrom(from, 2));
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 8) }, hoursFrom(from, 20));
    await recordInfected(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 2) }, hoursFrom(from, 21));
    await borrowBetweenWards(db, actorOf(H1), { fromWardId: h.generalWard, toWardId: h.icuWard, ...line("towel", 3) }, hoursFrom(from, 50));
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 15) }, hoursFrom(to, -3));
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, ...line("towel", 5) }, hoursFrom(to, -1)); // after the closing count
    const rows = await weeklyVariance(db, from, to);
    expect(rows).toEqual([expect.objectContaining({
      wardId: h.generalWard, itemCode: "towel", opening: 20, issued: 10, returned: 13, counted: 15, missing: 2,
    })]);
    // The borrowing ward was not counted this week: no variance is guessed for it.
    expect(rows.some((r) => r.wardId === h.icuWard)).toBe(false);
  });

  it("borrowed in counts as issued to the borrower", async () => {
    await borrowBetweenWards(db, actorOf(H1), { fromWardId: h.generalWard, toWardId: h.icuWard, ...line("blanket", 4) }, hoursFrom(from, 5));
    await recordWardCount(db, actorOf(H1), { wardId: h.icuWard, ...line("blanket", 4) }, hoursFrom(from, 6));
    expect(await weeklyVariance(db, from, to)).toEqual([expect.objectContaining({ wardId: h.icuWard, issued: 4, returned: 0, counted: 4, missing: 0 })]);
  });
});
