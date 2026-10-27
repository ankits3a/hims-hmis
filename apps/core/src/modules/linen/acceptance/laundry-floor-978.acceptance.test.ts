import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { BED_CLEAN_KINDS, newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { deliverBedEvents, mkHousekeepingWorld, releaseBed } from "../../../../test/helpers/housekeeping";
import { actorOf, H1, hoursFrom, mkLinenStaff, seedLinenHospital, SUPA } from "../../../../test/helpers/linen";
import { linenLaundryBatches, linenMovements, resources } from "../../../kernel/db/schema";
import { verifyClean } from "../../housekeeping";
import { assignBed } from "../../ipd";
import { acceptTask, completeTask, findTasks, startTask } from "../../tasks";
import {
  addMachine, approveCondemn, bedsWaitingForLinen, condemnPending, finishCycle, handToCssd, markMachineDown, markMachineUp,
  openRound, placeHold, plantView, recordInfected, recordQc, recordSoiled, recordWardCount, releaseBatch, releaseHold,
  runLinenClock, sealBag, seedLinenItems, sendToLaundry, setParLevel, signPickup, soiledPool, soiledRoomView, startCycle,
  topUpWard, weeklyVariance,
} from "../index";
import type { IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital, LinenStaff } from "../../../../test/helpers/linen";

/**
 * LD-1 (issue #978, decision 0087) — "DONE MEANS" of docs/specs/978-laundry-floor.md, D1..D7. Every check calls the
 * linen module's intents (and, for the bed-ready link, housekeeping's verify) — never a screen. No date is pinned:
 * every instant is the real clock's or a fixed offset from it.
 */
jest.setTimeout(120_000);

const key = (): string => randomUUID();

describe("LD-1 laundry floor — rounds, plant, bed-ready link, holds (#978)", () => {
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

  const issue = (wardId: string, itemCode: string, qty: number, at = now) =>
    topUpWard(db, actorOf(H1), { wardId, lines: [{ itemCode, qty }] }, at);

  /** One in-house batch through a cycle that meets the disinfection rule, released to quality check. */
  async function washed(batchId: string, machineId: string): Promise<void> {
    const c = await startCycle(db, s.operator, { machineId, batchIds: [batchId], program: "thermal" }, now);
    await finishCycle(db, s.operator, { cycleId: c.id, tempC: 75, holdMin: 5, chemical: "alkali + chlorine" }, now);
    await releaseBatch(db, s.operator, { batchId }, now);
  }

  it("spec #978 D1: a pickup is recorded only with both signatures, or runner-only with a reason; infected bags are never counted by piece", async () => {
    await issue(h.generalWard, "bedsheet", 6);
    await sealBag(db, s.nurse, { wardId: h.generalWard, tag: "INF-1", infected: true, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    const round = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, now);
    const pickup = { roundId: round.id, lines: [{ itemCode: "bedsheet", qty: 3 }], bags: [{ tag: "INF-1" }] };

    // No ward signature and no runner-only reason: nothing is recorded.
    await expect(signPickup(db, s.runner, pickup, now)).rejects.toMatchObject({ code: "ward_signature_missing" });
    await expect(signPickup(db, s.runner, { ...pickup, wardSign: { userId: s.nurse.id, pin: "0000" } }, now))
      .rejects.toMatchObject({ code: "bad_pin" });
    // The runner cannot sign for the ward.
    await expect(signPickup(db, s.runner, { ...pickup, wardSign: { userId: s.runner.id, pin: "9753" } }, now))
      .rejects.toMatchObject({ code: "signer_is_runner" });
    // A bag is counted as a bag: a piece count on it is not accepted.
    await expect(signPickup(db, s.runner, {
      ...pickup, bags: [{ tag: "INF-1", lines: [{ itemCode: "bedsheet", qty: 2 }] }], wardSign: { userId: s.nurse.id, pin: s.nursePin },
    }, now)).rejects.toMatchObject({ code: "bad_input" });
    expect(await soiledPool(db)).toEqual({ general: {}, infected: {} });

    const signed = await signPickup(db, s.runner, { ...pickup, wardSign: { userId: s.nurse.id, pin: s.nursePin } }, now);
    expect(signed).toMatchObject({ state: "signed", runnerOnly: false, wardSignedBy: s.nurse.id, runnerId: s.runner.id, pieces: 3, bags: 1 });
    await expect(signPickup(db, s.runner, { ...pickup, wardSign: { userId: s.nurse.id, pin: s.nursePin } }, now))
      .rejects.toMatchObject({ code: "round_closed" });
    const room = await soiledRoomView(db);
    expect(room.general).toEqual({ bedsheet: 3 });
    // The soiled room sees the sealed bag by tag and weight only — no piece count.
    expect(room.infectedBags).toEqual([{ tag: "INF-1", wardId: h.generalWard, weightGrams: null }]);

    // Runner-only: the ward did not sign, so a reason is required and the round says so.
    const r2 = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, now);
    await expect(signPickup(db, s.runner, { roundId: r2.id, lines: [{ itemCode: "bedsheet", qty: 1 }], runnerOnlyReason: "" }, now))
      .rejects.toMatchObject({ code: "bad_input" });
    await expect(signPickup(db, s.runner, { roundId: r2.id, lines: [{ itemCode: "bedsheet", qty: 1 }], runnerOnlyReason: "Nurse in a code blue" }, now))
      .resolves.toMatchObject({ state: "signed", runnerOnly: true, wardSignedBy: null, pieces: 1, bags: 0 });
  });

  it("spec #978 D2: an infected batch never shares a cycle with an ordinary one; an infected batch below temperature or time goes to rewash", async () => {
    const washer = await addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Washer 1 (60 kg)" });
    await issue(h.generalWard, "bedsheet", 7);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 5 }] }, now);
    await recordInfected(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    const inf = await sendToLaundry(db, s.operator, { infected: true, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 2 }] }, now);
    const gen = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 5 }] }, now);

    await expect(startCycle(db, s.operator, { machineId: washer.id, batchIds: [inf.batchId!, gen.batchId!], program: "thermal" }, now))
      .rejects.toMatchObject({ code: "mixed_cycle" });

    const c1 = await startCycle(db, s.operator, { machineId: washer.id, batchIds: [inf.batchId!], program: "thermal" }, now);
    // The machine is busy until its cycle ends.
    await expect(startCycle(db, s.operator, { machineId: washer.id, batchIds: [gen.batchId!], program: "warm" }, now))
      .rejects.toMatchObject({ code: "machine_busy" });
    await finishCycle(db, s.operator, { cycleId: c1.id, tempC: 60, holdMin: 3, chemical: "alkali" }, now);
    await expect(releaseBatch(db, s.operator, { batchId: inf.batchId! }, now)).rejects.toMatchObject({ code: "disinfection_missed" });
    const batch = async (id: string) => (await db.select().from(linenLaundryBatches).where(eq(linenLaundryBatches.id, id)))[0]!;
    expect((await batch(inf.batchId!)).state).toBe("rewash");

    // Rewashed hot enough for long enough: it is released to quality check.
    const c2 = await startCycle(db, s.operator, { machineId: washer.id, batchIds: [inf.batchId!], program: "thermal" }, now);
    await finishCycle(db, s.operator, { cycleId: c2.id, tempC: 71, holdMin: 3, chemical: "alkali + chlorine" }, now);
    await expect(releaseBatch(db, s.operator, { batchId: inf.batchId! }, now)).resolves.toMatchObject({ state: "qc" });

    // An ordinary batch is not held to the disinfection rule.
    const c3 = await startCycle(db, s.operator, { machineId: washer.id, batchIds: [gen.batchId!], program: "warm" }, now);
    await finishCycle(db, s.operator, { cycleId: c3.id, tempC: 40, holdMin: 10, chemical: "detergent" }, now);
    await expect(releaseBatch(db, s.operator, { batchId: gen.batchId! }, now)).resolves.toMatchObject({ state: "qc" });
  });

  it("spec #978 D3: a bed cleaned on a ward short of a set shows waiting for linen, not ready; the rush top-up clears it", async () => {
    const w = await mkHousekeepingWorld(db);
    await seedLinenItems(db);
    const bedStatus = async (id: string) => (await db.select().from(resources).where(eq(resources.id, id)))[0]!.status;
    const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };
    const bedId = await w.bed("LD-D3");
    await assignBed(db, w.desk, { idempotencyKey: key(), admissionId: newId(), bedId, patientId: await w.patient("male"), need: GENERAL });
    // The ward is live on linen and its shelf is empty.
    await recordWardCount(db, actorOf(H1), { wardId: w.wardId, lines: [{ itemCode: "bedsheet", qty: 0 }] }, hoursFrom(now, -1));
    await releaseBed(db, w.dutyManager, bedId);
    await deliverBedEvents(db, bedId);
    const [task] = await findTasks(db, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId });
    await acceptTask(db, w.hk1, { taskId: task!.id });
    await startTask(db, w.hk1, { taskId: task!.id });
    await completeTask(db, w.hk1, { taskId: task!.id, proof: { kind: "tap" } });
    await expect(verifyClean(db, w.nurse, { taskId: task!.id })).resolves.toMatchObject({ state: "verified" });

    // Clean, but not made: the bed is not ready and says why.
    expect(await bedStatus(bedId)).toBe("cleaning");
    expect(await bedsWaitingForLinen(db)).toEqual([expect.objectContaining({ bedId, wardId: w.wardId, rush: true })]);

    // The rush top-up reaches the ward: the wait clears and the bed is free.
    await topUpWard(db, actorOf(H1), { wardId: w.wardId }, now);
    expect(await bedsWaitingForLinen(db)).toEqual([]);
    expect(await bedStatus(bedId)).toBe("available");
  });

  it("spec #978 D4: linen under an MLC, chemotherapy or radioactive hold enters no pickup and no batch until its owner releases it", async () => {
    await issue(h.generalWard, "bedsheet", 9);
    const bag = (tag: string) => sealBag(db, s.nurse, {
      wardId: h.generalWard, bedId: h.aGeneralBed, tag, infected: true, lines: [{ itemCode: "bedsheet", qty: 1 }],
    }, now);
    const pickupOf = async (tag: string) => {
      const r = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, now);
      return signPickup(db, s.runner, { roundId: r.id, bags: [{ tag }], wardSign: { userId: s.nurse.id, pin: s.nursePin } }, now);
    };

    // MLC: released only with the police receiver recorded; the linen goes to the police, not to the laundry.
    await bag("MLC-1");
    const mlc = await placeHold(db, s.nurse, { kind: "mlc", bedId: h.aGeneralBed, note: "Assault case" }, now);
    await expect(pickupOf("MLC-1")).rejects.toMatchObject({ code: "on_hold" });
    await expect(releaseHold(db, s.nurseInCharge, { holdId: mlc.id }, now)).rejects.toMatchObject({ code: "police_receiver_missing" });
    await expect(releaseHold(db, s.nurseInCharge, {
      holdId: mlc.id, police: { name: "R. Kumar", rank: "Sub-Inspector", station: "Kotwali" },
    }, now)).resolves.toMatchObject({ state: "handed_over" });
    await expect(pickupOf("MLC-1")).rejects.toMatchObject({ code: "bag_gone" });

    // Chemotherapy: no hand releases it; the clock does, 48 hours after the dose.
    await bag("CHEMO-1");
    const chemo = await placeHold(db, s.nurse, { kind: "chemo", bedId: h.aGeneralBed, doseAt: now.toISOString() }, now);
    await expect(releaseHold(db, s.nurseInCharge, { holdId: chemo.id }, now)).rejects.toMatchObject({ code: "released_by_clock" });
    await expect(pickupOf("CHEMO-1")).rejects.toMatchObject({ code: "on_hold" });
    await runLinenClock(db, hoursFrom(now, 47));
    await expect(pickupOf("CHEMO-1")).rejects.toMatchObject({ code: "on_hold" });
    await runLinenClock(db, hoursFrom(now, 49));
    await expect(pickupOf("CHEMO-1")).resolves.toMatchObject({ state: "signed", bags: 1 });

    // Radioactive iodine: only the appointed RSO releases it. A held bag cannot be put in a batch either.
    await bag("I131-1");
    const rad = await placeHold(db, s.nurse, { kind: "radioactive", bedId: h.aGeneralBed }, now);
    await expect(sendToLaundry(db, s.operator, { infected: true, mode: "in_house", bagTags: ["I131-1"] }, now))
      .rejects.toMatchObject({ code: "on_hold" });
    await expect(releaseHold(db, s.nurseInCharge, { holdId: rad.id }, now)).rejects.toMatchObject({ code: "not_rso" });
    await expect(releaseHold(db, s.rso, { holdId: rad.id }, now)).resolves.toMatchObject({ state: "released" });
    await expect(pickupOf("I131-1")).resolves.toMatchObject({ state: "signed", bags: 1 });
    await expect(sendToLaundry(db, s.operator, { infected: true, mode: "in_house", bagTags: ["CHEMO-1", "I131-1"] }, now))
      .resolves.toMatchObject({ batchId: expect.any(String) });
  });

  it("spec #978 D5: a machine marked down takes no new batch, and its work shows as send to vendor", async () => {
    const washer = await addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Washer 1" });
    await issue(h.generalWard, "bedsheet", 4);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 4 }] }, now);
    const b = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 4 }] }, now);
    expect((await plantView(db, now)).vendorQueue).toEqual([]);

    await markMachineDown(db, s.operator, { machineId: washer.id, reason: "Drum bearing noise" }, now);
    await expect(startCycle(db, s.operator, { machineId: washer.id, batchIds: [b.batchId!], program: "warm" }, now))
      .rejects.toMatchObject({ code: "machine_down" });
    expect((await plantView(db, now)).vendorQueue.map((q) => q.batchId)).toEqual([b.batchId]);

    await markMachineUp(db, s.supervisor, { machineId: washer.id }, now);
    expect((await plantView(db, now)).vendorQueue).toEqual([]);
    await expect(startCycle(db, s.operator, { machineId: washer.id, batchIds: [b.batchId!], program: "warm" }, now))
      .resolves.toMatchObject({ id: expect.any(String) });
  });

  it("spec #978 D6: every movement, quality check included, lands in the ledger, and weekly loss stays one sum", async () => {
    const washer = await addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Washer 1" });
    const t0 = hoursFrom(now, -3);
    await issue(h.generalWard, "bedsheet", 10, t0);
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 10 }] }, hoursFrom(now, -2));
    const round = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, now);
    await signPickup(db, s.runner, { roundId: round.id, lines: [{ itemCode: "bedsheet", qty: 4 }], runnerOnlyReason: "Ward busy" }, hoursFrom(now, -1));
    const b = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 4 }] }, now);
    await washed(b.batchId!, washer.id);

    // The four outcomes must add up to what was washed.
    await expect(recordQc(db, s.qc, { batchId: b.batchId!, lines: [{ itemCode: "bedsheet", pass: 1, rewash: 1, mend: 1, condemn: 0 }] }, now))
      .rejects.toMatchObject({ code: "qc_mismatch" });
    await recordQc(db, s.qc, { batchId: b.batchId!, lines: [{ itemCode: "bedsheet", pass: 1, rewash: 1, mend: 1, condemn: 1 }] }, now);
    const kinds = (await db.select().from(linenMovements).where(eq(linenMovements.batchId, b.batchId!))).map((m) => `${m.kind}:${m.qty}`).sort();
    expect(kinds).toEqual(["laundry_in:1", "laundry_out:4", "qc_mend:1", "qc_rewash:1"]);
    // The rewash goes back to the soiled room; the condemned piece waits for a second person.
    expect((await soiledPool(db)).general).toEqual({ bedsheet: 1 });
    const pending = await condemnPending(db);
    expect(pending).toEqual([expect.objectContaining({ wardId: null, itemCode: "bedsheet", qty: 1, requestedBy: s.qc.id })]);
    await expect(approveCondemn(db, s.qc, { requestId: pending[0]!.id }, now)).rejects.toMatchObject({ code: "approver_is_requester" });
    await approveCondemn(db, s.supervisor, { requestId: pending[0]!.id }, now);
    expect((await db.select().from(linenMovements).where(eq(linenMovements.kind, "condemn")))).toHaveLength(1);

    // The ward's loss is still one sum: opening + issued − returned − counted.
    await recordWardCount(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 5 }] }, now);
    const rows = await weeklyVariance(db, hoursFrom(now, -2.5), hoursFrom(now, 1));
    expect(rows.find((r) => r.wardId === h.generalWard && r.itemCode === "bedsheet")).toMatchObject({ opening: 0, returned: 4, counted: 5 });
    const all = await weeklyVariance(db, hoursFrom(now, -1.5), hoursFrom(now, 1));
    expect(all.find((r) => r.wardId === h.generalWard && r.itemCode === "bedsheet")).toMatchObject({ opening: 10, issued: 0, returned: 4, counted: 5, missing: 1 });
  });

  it("spec #978 D7: theatre sets go from laundry to CSSD with a CSSD signature; baby linen never shares a batch with adult linen", async () => {
    const washer = await addMachine(db, s.supervisor, { code: "W1", kind: "washer", name: "Washer 1" });
    await setParLevel(db, actorOf(SUPA), { wardId: s.theatre, itemCode: "ot_gown", par: 10 }, now);
    await issue(s.theatre, "ot_gown", 6);
    await recordSoiled(db, actorOf(H1), { wardId: s.theatre, lines: [{ itemCode: "ot_gown", qty: 4 }] }, now);
    const ot = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "ot_gown", qty: 4 }] }, now);
    await washed(ot.batchId!, washer.id);
    await recordQc(db, s.qc, { batchId: ot.batchId!, lines: [{ itemCode: "ot_gown", pass: 4, rewash: 0, mend: 0, condemn: 0 }] }, now);

    // Theatre sets go to CSSD, not to the linen store, and only on a CSSD signature.
    await expect(handToCssd(db, s.operator, { batchId: ot.batchId!, cssdSign: { userId: s.cssd.id, pin: "0000" } }, now))
      .rejects.toMatchObject({ code: "bad_pin" });
    await expect(handToCssd(db, s.operator, { batchId: ot.batchId!, cssdSign: { userId: s.nurse.id, pin: s.nursePin } }, now))
      .rejects.toMatchObject({ code: "not_cssd" });
    await expect(handToCssd(db, s.operator, { batchId: ot.batchId!, cssdSign: { userId: s.cssd.id, pin: s.cssdPin } }, now))
      .resolves.toMatchObject({ batchId: ot.batchId });
    const otMoves = (await db.select().from(linenMovements).where(eq(linenMovements.batchId, ot.batchId!))).map((m) => `${m.kind}:${m.qty}`).sort();
    expect(otMoves).toEqual(["issue_to_cssd:4", "laundry_out:4"]);

    // Baby linen: its own stream, its own batch, its own cycle.
    await setParLevel(db, actorOf(SUPA), { wardId: s.babyWard, itemCode: "baby_wrap", par: 10 }, now);
    await issue(s.babyWard, "baby_wrap", 5);
    await recordSoiled(db, actorOf(H1), { wardId: s.babyWard, lines: [{ itemCode: "baby_wrap", qty: 3 }] }, now);
    await issue(h.generalWard, "bedsheet", 3);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 3 }] }, now);
    await expect(sendToLaundry(db, s.operator, {
      infected: false, mode: "in_house", lines: [{ itemCode: "baby_wrap", qty: 3 }, { itemCode: "bedsheet", qty: 3 }],
    }, now)).rejects.toMatchObject({ code: "mixed_stream" });
    const baby = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "baby_wrap", qty: 3 }] }, now);
    const adult = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 3 }] }, now);
    await expect(startCycle(db, s.operator, { machineId: washer.id, batchIds: [baby.batchId!, adult.batchId!], program: "warm" }, now))
      .rejects.toMatchObject({ code: "mixed_stream" });
    const batches = await db.select().from(linenLaundryBatches);
    expect(batches.find((x) => x.id === baby.batchId)).toMatchObject({ stream: "baby" });
    expect(batches.find((x) => x.id === adult.batchId)).toMatchObject({ stream: "ward" });
  });
});

