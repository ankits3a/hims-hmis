import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { H1, SUPA, SUPB, actorOf, seedLinenHospital } from "../../../../test/helpers/linen";
import { linenMovements } from "../../../kernel/db/schema";
import { approveCondemn, rejectCondemn, requestCondemn, topUpWard, wardStates } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital } from "../../../../test/helpers/linen";

/**
 * DONE MEANS (brief E2.4 (v)): "condemn needs an approver other than the requester". Until a second person approves,
 * nothing leaves the ward's book; the requester can neither approve nor reject their own request.
 */
describe("acceptance — condemned linen needs a second person", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  const now = new Date();

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 30 }] }, now);
  });

  const onHand = async () => (await wardStates(db, now, h.generalWard))[0]!.items.find((i) => i.itemCode === "bedsheet")!.onHand;
  const condemned = async () => (await db.select().from(linenMovements)).filter((m) => m.kind === "condemn");

  it("the requester's own approval is refused and writes nothing; another supervisor's approval writes it off", async () => {
    const req = await requestCondemn(db, actorOf(SUPA), { wardId: h.generalWard, itemCode: "bedsheet", qty: 3, reason: "torn" }, now);
    await expect(approveCondemn(db, actorOf(SUPA), { requestId: req.id }, now)).rejects.toMatchObject({ code: "approver_is_requester" });
    await expect(rejectCondemn(db, actorOf(SUPA), { requestId: req.id }, now)).rejects.toMatchObject({ code: "approver_is_requester" });
    expect(await condemned()).toHaveLength(0);
    expect(await onHand()).toBe(30);

    const ok = await approveCondemn(db, actorOf(SUPB), { requestId: req.id }, now);
    expect(ok).toMatchObject({ state: "approved", decidedBy: SUPB, requestedBy: SUPA });
    expect((await condemned()).map((m) => [m.qty, m.actorId])).toEqual([[3, SUPB]]);
    expect(await onHand()).toBe(27);
    await expect(approveCondemn(db, actorOf(H1), { requestId: req.id }, now)).rejects.toMatchObject({ code: "request_closed" });
  });

  it("a rejection by another person writes nothing off", async () => {
    const req = await requestCondemn(db, actorOf(H1), { wardId: h.generalWard, itemCode: "bedsheet", qty: 2, reason: "stained" }, now);
    expect(await rejectCondemn(db, actorOf(SUPB), { requestId: req.id, note: "wash again" }, now)).toMatchObject({ state: "rejected" });
    expect(await condemned()).toHaveLength(0);
    expect(await onHand()).toBe(30);
  });
});
