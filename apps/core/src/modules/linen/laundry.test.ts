import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { H1, actorOf, hoursFrom, mkLinenStaff, seedLinenHospital } from "../../../test/helpers/linen";
import { linenLaundryBatches, linenRounds, maintenanceTickets } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../kernel/resources";
import {
  addMachine, dueSlots, finishCycle, markMachineDown, mendReturn, mendingPool, openRound, placeHold, receiveFromLaundry,
  recordQc, recordSoiled, releaseBatch, routeToVendor, runLinenClock, rushDemand, sealBag, sealedBags, sendToLaundry, signDelivery,
  signPickup, soiledRoomView, startCycle, topUpWard, wardBeds, wardStates, weighBag,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { LinenHospital, LinenStaff } from "../../../test/helpers/linen";

/**
 * LD-1 (#978) — the laundry floor beyond its done-means checks: delivery rounds, the round clock, a breakdown's repair
 * ticket, bag tags and weights, mending, sending plant work to the vendor, and the day's rush demand.
 */
jest.setTimeout(60_000);

describe("LD-1 laundry floor — rounds, clock, plant and mending", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  let s: LinenStaff;
  let now: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
    s = await mkLinenStaff(db, h);
    now = new Date();
  });

  const sign = () => ({ wardSign: { userId: s.nurse.id, pin: s.nursePin } });

  it("a delivery to a ward short of par issues up to par on the ward's signature; a ward at par is skipped unsigned", async () => {
    const r1 = await openRound(db, s.runner, { wardId: h.icuWard, kind: "delivery" }, now);
    await expect(signDelivery(db, s.runner, { roundId: r1.id }, now)).rejects.toMatchObject({ code: "ward_signature_missing" });
    const done = await signDelivery(db, s.runner, { roundId: r1.id, ...sign() }, now);
    expect(done).toMatchObject({ state: "signed", wardSignedBy: s.nurse.id, pieces: 3 * 5 * 6 });
    expect((await wardStates(db, now, h.icuWard))[0]!.belowPar).toBe(false);
    const r2 = await openRound(db, s.runner, { wardId: h.icuWard, kind: "delivery" }, now);
    await expect(signDelivery(db, s.runner, { roundId: r2.id }, now)).resolves.toMatchObject({ state: "skipped", pieces: 0 });
    // A pickup round is not a delivery, and the other way round.
    const r3 = await openRound(db, s.runner, { wardId: h.icuWard, kind: "pickup" }, now);
    await expect(signDelivery(db, s.runner, { roundId: r3.id, ...sign() }, now)).rejects.toMatchObject({ code: "not_a_delivery" });
  });

  it("the clock raises each live ward's round of a slot once, and nothing for a ward never on linen", async () => {
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 1 }] }, now);
    // 07:40 IST on the day of `now` (the clock reads only the instant it is given).
    const day = new Date(`${now.toISOString().slice(0, 10)}T02:10:00.000Z`);
    expect(dueSlots(day).map((x) => x.kind)).toEqual(["pickup"]);
    await runLinenClock(db, day);
    await runLinenClock(db, hoursFrom(day, 0.1));
    const rounds = await db.select().from(linenRounds);
    expect(rounds.map((r) => [r.wardResourceId, r.kind])).toEqual([[h.generalWard, "pickup"]]);
    // Far past every slot's catch-up window, nothing new is raised.
    expect(dueSlots(hoursFrom(day, -5))).toEqual([]);
  });

  it("a machine down with a place raises one repair ticket there, tagged with the machine's code", async () => {
    const room = await withTx(db, async (tx) => (await createResource(tx, { type: "system", id: "t" }, KERNEL_RESOURCE_KINDS, {
      kind: "room", code: "LAUNDRY", name: "Laundry", parentId: h.floorId,
    })).resourceId);
    await expect(addMachine(db, s.supervisor, { code: "W9", kind: "washer", name: "Washer 9", placeId: "nope" })).rejects.toMatchObject({ code: "unknown_place" });
    const m = await addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Washer 1", placeId: room }, now);
    await expect(addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Again" })).rejects.toMatchObject({ code: "code_taken" });
    const down = await markMachineDown(db, s.operator, { machineId: m.id, reason: "Door seal leaking" }, now);
    expect(down.ticketId).not.toBeNull();
    const ticket = (await db.select().from(maintenanceTickets).where(eq(maintenanceTickets.id, down.ticketId!)))[0]!;
    expect(ticket).toMatchObject({ placeResourceId: room, itemTag: "W1" });
  });

  it("a bag's tag is in use while the bag is on the floor, it is weighed in the soiled room, and it is never opened", async () => {
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 4 }] }, now);
    await sealBag(db, s.nurse, { wardId: h.generalWard, tag: "T-1", infected: true, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    await expect(sealBag(db, s.nurse, { wardId: h.generalWard, tag: "T-1", infected: true, lines: [{ itemCode: "bedsheet", qty: 1 }] }, now))
      .rejects.toMatchObject({ code: "tag_in_use" });
    await expect(weighBag(db, s.operator, { tag: "T-1", weightGrams: 900 })).rejects.toMatchObject({ code: "bag_not_here" });
    const r = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, now);
    await signPickup(db, s.runner, { roundId: r.id, bags: [{ tag: "T-1" }], ...sign() }, now);
    await weighBag(db, s.operator, { tag: "T-1", weightGrams: 900 });
    expect((await soiledRoomView(db)).infectedBags).toEqual([{ tag: "T-1", wardId: h.generalWard, weightGrams: 900 }]);
    // An infected bag goes in an infected batch only; once sent, its tag is free again.
    await expect(sendToLaundry(db, s.operator, { infected: false, bagTags: ["T-1"] }, now)).rejects.toMatchObject({ code: "bag_wrong_batch" });
    await sendToLaundry(db, s.operator, { infected: true, mode: "in_house", bagTags: ["T-1"] }, now);
    expect((await soiledRoomView(db)).infectedBags).toEqual([]);
    await expect(sealBag(db, s.nurse, { wardId: h.generalWard, tag: "T-1", infected: false, lines: [{ itemCode: "bedsheet", qty: 1 }] }, now))
      .resolves.toMatchObject({ tag: "T-1" });
  });

  it("the ward signs on the runner's phone by the name it signs in with and its PIN; the floor lists sealed bags and beds", async () => {
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 3 }] }, now);
    await sealBag(db, s.nurse, { wardId: h.generalWard, bedId: h.aGeneralBed, tag: "B-9", infected: false, lines: [{ itemCode: "bedsheet", qty: 1 }] }, now);
    await placeHold(db, s.nurse, { kind: "radioactive", bedId: h.aGeneralBed }, now);
    expect(await sealedBags(db)).toEqual([{ tag: "B-9", wardId: h.generalWard, bedId: h.aGeneralBed, bedName: "General bed 1", infected: false, held: true }]);
    expect((await wardBeds(db)).filter((b) => b.wardId === h.generalWard)).toHaveLength(10);
    const r = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, now);
    const lines = [{ itemCode: "bedsheet", qty: 1 }];
    await expect(signPickup(db, s.runner, { roundId: r.id, lines, wardSign: { username: "ln.nurse", pin: "0000" } }, now)).rejects.toMatchObject({ code: "bad_pin" });
    await expect(signPickup(db, s.runner, { roundId: r.id, lines, wardSign: { username: "nobody.here", pin: s.nursePin } }, now)).rejects.toMatchObject({ code: "bad_pin" });
    await expect(signPickup(db, s.runner, { roundId: r.id, lines, wardSign: { username: "ln.runner", pin: "9753" } }, now)).rejects.toMatchObject({ code: "signer_is_runner" });
    await expect(signPickup(db, s.runner, { roundId: r.id, lines, wardSign: { username: "ln.nurse", pin: s.nursePin } }, now))
      .resolves.toMatchObject({ state: "signed", wardSignedBy: s.nurse.id });
  });

  it("a hold names a bed under a ward, and a chemotherapy hold needs its dose time", async () => {
    await expect(placeHold(db, s.nurse, { kind: "mlc", bedId: h.generalWard }, now)).rejects.toMatchObject({ code: "unknown_bed" });
    await expect(placeHold(db, s.nurse, { kind: "chemo", bedId: h.aGeneralBed }, now)).rejects.toMatchObject({ code: "bad_input" });
    await expect(placeHold(db, s.nurse, { kind: "mlc", bedId: h.aGeneralBed, doseAt: now.toISOString() }, now)).rejects.toMatchObject({ code: "bad_input" });
  });

  it("mended pieces return to the store, never more than are at mending", async () => {
    const washer = await addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Washer 1" });
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 3 }] }, now);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "towel", qty: 3 }] }, now);
    const b = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "towel", qty: 3 }] }, now);
    const c = await startCycle(db, s.operator, { machineId: washer.id, batchIds: [b.batchId!], program: "warm" }, now);
    await finishCycle(db, s.operator, { cycleId: c.id, tempC: 40, holdMin: 10, chemical: "detergent" }, now);
    await releaseBatch(db, s.operator, { batchId: b.batchId! }, now);
    await recordQc(db, s.qc, { batchId: b.batchId!, lines: [{ itemCode: "towel", pass: 1, rewash: 0, mend: 2, condemn: 0 }] }, now);
    expect(await mendingPool(db)).toEqual({ towel: 2 });
    await expect(mendReturn(db, s.qc, { lines: [{ itemCode: "towel", qty: 3 }] }, now)).rejects.toMatchObject({ code: "exceeds_mending" });
    await mendReturn(db, s.qc, { lines: [{ itemCode: "towel", qty: 2 }] }, now);
    expect(await mendingPool(db)).toEqual({});
    // A checked batch is not checked twice.
    await expect(recordQc(db, s.qc, { batchId: b.batchId!, lines: [{ itemCode: "towel", pass: 3, rewash: 0, mend: 0, condemn: 0 }] }, now))
      .rejects.toMatchObject({ code: "not_at_qc" });
  });

  it("plant work sent to the vendor is received like any vendor batch", async () => {
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    const b = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    await routeToVendor(db, s.operator, { batchId: b.batchId! });
    await expect(routeToVendor(db, s.operator, { batchId: b.batchId! })).rejects.toMatchObject({ code: "not_in_plant" });
    await receiveFromLaundry(db, s.operator, { batchId: b.batchId!, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    expect((await db.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.id, b.batchId!)))[0]).toMatchObject({ mode: "vendor", state: "received" });
  });

  it("with no discharge planned and no case listed, the day's rush demand is empty", async () => {
    await expect(rushDemand(db, now)).resolves.toMatchObject({ wards: [], theatreCases: 0 });
  });
});
