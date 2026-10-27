import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { actorOf, H1, mkLinenStaff, mkVendorDesk, seedLinenHospital } from "../../../../test/helpers/linen";
import { mkUser } from "../../../../test/helpers/opd";
import { withTx } from "../../../kernel/db/client";
import { linenMovements, stockBatches, users } from "../../../kernel/db/schema";
import { createStore, postMovement, registerItem } from "../../materials";
import {
  addLinenVendor, approveBillExcess, approveCondemn, approveRecovery, bookBalances, chemicalUse, checkVendorBill, challanFor,
  exchangeUniform, fileLicence, finishCycle, issueUniform, istDayOf, istMonthStart, istMonthOf, licenceCalendar, openRound, raiseRecovery,
  receiveFromLaundry, recordChallanReturn, recordSoiled, registerPiece, rejectRecovery, releaseBatch, requestCondemn,
  returnUniform, routeToVendor, sendToLaundry, setLinenItemCost, setParLevel, setUniformRole, setVendorRate, signPickup,
  startCycle, addMachine, topUpWard, uniformDues, vendorMonthReport,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { LinenHospital, LinenStaff, VendorDesk } from "../../../../test/helpers/linen";

/**
 * LD-2 (issue #979, decisions 0087 and 0092) — "DONE MEANS" of docs/specs/979-laundry-ld2.md, D1..D8. Every check calls
 * the linen module's intents and reads — never a screen. No date is pinned: every instant is an offset from the start
 * of the real clock's IST month, so a month's acts stay inside one month whatever day the suite runs.
 */
jest.setTimeout(120_000);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("LD-2 vendor laundry — challans, recovery, bill check, uniforms, tags, chemicals, licences (#979)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let h: LinenHospital;
  let s: LinenStaff;
  let d: VendorDesk;
  /** One hour into the current IST month. */
  let t0: Date;
  let month: string;
  const at = (ms: number): Date => new Date(t0.getTime() + ms);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    h = await seedLinenHospital(db);
    s = await mkLinenStaff(db, h);
    d = await mkVendorDesk(db);
    t0 = new Date(istMonthStart(new Date()).getTime() + HOUR);
    month = istMonthOf(t0);
  });

  /** Put `qty` bedsheets on the general ward's book and in the soiled room. */
  async function soiled(qty: number, when = t0, itemCode = "bedsheet"): Promise<void> {
    await setParLevel(db, s.supervisor, { wardId: h.generalWard, itemCode, par: 5000 }, when);
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode, qty }] }, when);
    await recordSoiled(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode, qty }] }, when);
  }

  async function vendor(): Promise<string> {
    return (await addLinenVendor(db, d.desk, { name: "Clean Wash Services" }, t0)).id;
  }

  async function challan(vendorId: string, qty: number, when = t0): Promise<{ batchId: string; challanId: string }> {
    await soiled(qty, when);
    const b = await sendToLaundry(db, d.desk, {
      infected: false, mode: "vendor", linenVendorId: vendorId, weightGrams: qty * 600, lines: [{ itemCode: "bedsheet", qty }],
    }, when);
    return { batchId: b.batchId!, challanId: (await challanFor(db, b.batchId!))!.id };
  }

  it("spec #979 D1: a vendor batch cannot leave without an outward challan of items, counts and weight; its return is recorded against it per piece", async () => {
    const v = await vendor();
    await soiled(10);
    await expect(sendToLaundry(db, d.desk, { infected: false, mode: "vendor", lines: [{ itemCode: "bedsheet", qty: 10 }] }, t0))
      .rejects.toMatchObject({ code: "challan_required" });
    await expect(sendToLaundry(db, d.desk, { infected: false, mode: "vendor", linenVendorId: v, lines: [{ itemCode: "bedsheet", qty: 10 }] }, t0))
      .rejects.toMatchObject({ code: "challan_required" });
    const b = await sendToLaundry(db, d.desk, {
      infected: false, mode: "vendor", linenVendorId: v, weightGrams: 6500, lines: [{ itemCode: "bedsheet", qty: 10 }],
    }, t0);
    const c = (await challanFor(db, b.batchId!))!;
    expect(c).toMatchObject({ linenVendorId: v, weightGrams: 6500, pieces: 10, lines: [{ itemCode: "bedsheet", qty: 10 }] });
    expect(c.challanNo).toMatch(/\S/);
    // The old hand receipt does not bypass the challan.
    await expect(receiveFromLaundry(db, d.desk, { batchId: b.batchId!, lines: [{ itemCode: "bedsheet", qty: 10 }] }, t0))
      .rejects.toMatchObject({ code: "use_challan" });
    // A plant batch routed to the vendor leaves on a challan too.
    await soiled(4);
    const inHouse = await sendToLaundry(db, d.desk, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 4 }] }, t0);
    await expect(routeToVendor(db, d.desk, { batchId: inHouse.batchId! })).rejects.toMatchObject({ code: "challan_required" });
    await routeToVendor(db, d.desk, { batchId: inHouse.batchId!, linenVendorId: v, weightGrams: 2400 }, t0);
    expect(await challanFor(db, inHouse.batchId!)).toMatchObject({ pieces: 4, weightGrams: 2400 });
    // Back at the dock: 7 accepted, 1 refused damaged, 1 refused stained (back for free rewash), 1 missing.
    await expect(recordChallanReturn(db, d.desk, { challanId: c.id, lines: [{ itemCode: "bedsheet", accepted: 9, damaged: 1, stained: 1 }] }, at(HOUR)))
      .rejects.toMatchObject({ code: "more_than_sent" });
    const r = await recordChallanReturn(db, d.desk, { challanId: c.id, lines: [{ itemCode: "bedsheet", accepted: 7, damaged: 1, stained: 1 }] }, at(HOUR));
    expect(r.lines).toEqual([{ itemCode: "bedsheet", sent: 10, accepted: 7, damaged: 1, stained: 1, missing: 2 }]);
    const ins = await db.select().from(linenMovements).where(eq(linenMovements.batchId, b.batchId!));
    expect(ins.filter((m) => m.kind === "laundry_in").reduce((n, m) => n + m.qty, 0)).toBe(8);
    expect(r.condemnRequests).toBe(1);
  });

  it("spec #979 D2: the monthly vendor report proposes a recovery at replacement cost only when the vendor is below par", async () => {
    const v = await vendor();
    await setLinenItemCost(db, s.supervisor, { itemCode: "bedsheet", pricePaise: 40_000 });
    // Small month (< 1,000 pieces): 20 sent, 3 damaged, 5 never back → 8 > 5 → below par.
    const one = await challan(v, 20);
    await recordChallanReturn(db, d.desk, { challanId: one.challanId, lines: [{ itemCode: "bedsheet", accepted: 12, damaged: 3, stained: 0 }] }, at(2 * HOUR));
    const report = await vendorMonthReport(db, v, month, at(40 * DAY));
    expect(report).toMatchObject({ piecesSent: 20, lost: 5, damaged: 3, batches: 1, lateBatches: 0, belowPar: true });
    expect(report.proposed).toMatchObject({ totalPaise: 8 * 40_000 });
    expect(report.proposed!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "lost", itemCode: "bedsheet", qty: 5, unitPaise: 40_000 }),
      expect.objectContaining({ kind: "damaged", itemCode: "bedsheet", qty: 3, unitPaise: 40_000 }),
    ]));
  });

  it("spec #979 D2: at or within par the report proposes none (0.5% at 1,000 pieces and more; 5 pieces below)", async () => {
    const v = await vendor();
    await setLinenItemCost(db, s.supervisor, { itemCode: "bedsheet", pricePaise: 40_000 });
    const small = await challan(v, 20);
    await recordChallanReturn(db, d.desk, { challanId: small.challanId, lines: [{ itemCode: "bedsheet", accepted: 15, damaged: 2, stained: 0 }] }, at(2 * HOUR));
    // 3 lost + 2 damaged = 5: not more than 5.
    const r1 = await vendorMonthReport(db, v, month, at(40 * DAY));
    expect(r1).toMatchObject({ lost: 3, damaged: 2, belowPar: false, proposed: null });
    await expect(raiseRecovery(db, d.desk, { linenVendorId: v, month }, at(40 * DAY))).rejects.toMatchObject({ code: "within_par" });
    // A big month: 1,000 more pieces; 5 more lost → 10 of 1,020 = 0.98% > 0.5% → below par.
    const big = await challan(v, 1000, at(HOUR));
    await recordChallanReturn(db, d.desk, { challanId: big.challanId, lines: [{ itemCode: "bedsheet", accepted: 995, damaged: 0, stained: 0 }] }, at(3 * HOUR));
    expect(await vendorMonthReport(db, v, month, at(40 * DAY))).toMatchObject({ piecesSent: 1020, lost: 8, damaged: 2, belowPar: true });
    // A batch back late (after its 24-hour turnaround) counts; 1 late of 2 = 50% > 10% → below par on lateness alone.
    const v2 = (await addLinenVendor(db, d.desk, { name: "Second Laundry" }, t0)).id;
    const late = await challan(v2, 10);
    await recordChallanReturn(db, d.desk, { challanId: late.challanId, lines: [{ itemCode: "bedsheet", accepted: 10, damaged: 0, stained: 0 }] }, at(30 * HOUR));
    const onTime = await challan(v2, 10);
    await recordChallanReturn(db, d.desk, { challanId: onTime.challanId, lines: [{ itemCode: "bedsheet", accepted: 10, damaged: 0, stained: 0 }] }, at(2 * HOUR));
    expect(await vendorMonthReport(db, v2, month, at(40 * DAY))).toMatchObject({ lost: 0, damaged: 0, batches: 2, lateBatches: 1, belowPar: true });
  });

  it("spec #979 D3: a recovery takes effect only on the owner's or finance's approval, never its proposer's; a piece returned later is reversed on the next report", async () => {
    const v = await vendor();
    await setLinenItemCost(db, s.supervisor, { itemCode: "bedsheet", pricePaise: 40_000 });
    const one = await challan(v, 20);
    await recordChallanReturn(db, d.desk, { challanId: one.challanId, lines: [{ itemCode: "bedsheet", accepted: 12, damaged: 3, stained: 0 }] }, at(2 * HOUR));
    const rec = await raiseRecovery(db, d.owner, { linenVendorId: v, month }, at(40 * DAY));
    expect(rec).toMatchObject({ state: "proposed", proposedPaise: 320_000 });
    await expect(approveRecovery(db, d.owner, { recoveryId: rec.id }, at(40 * DAY))).rejects.toMatchObject({ code: "approver_is_requester" });
    await expect(approveRecovery(db, d.desk, { recoveryId: rec.id }, at(40 * DAY))).rejects.toMatchObject({ code: "not_approver" });
    const second = await raiseRecovery(db, d.desk, { linenVendorId: v, month }, at(40 * DAY)).catch((e: { code: string }) => e);
    expect(second).toMatchObject({ code: "recovery_exists" });
    // Rejected, raised again by the desk, approved by finance with an edit.
    await rejectRecovery(db, d.finance, { recoveryId: rec.id, note: "Recheck" }, at(40 * DAY));
    const again = await raiseRecovery(db, d.desk, { linenVendorId: v, month }, at(41 * DAY));
    const ok = await approveRecovery(db, d.finance, { recoveryId: again.id, amountPaise: 300_000, note: "rounded" }, at(41 * DAY));
    expect(ok).toMatchObject({ state: "approved", approvedPaise: 300_000, decidedBy: d.finance.id });
    // Two of the five lost bedsheets come back after the report: the next month's report reverses them.
    await recordChallanReturn(db, d.desk, { challanId: one.challanId, lines: [{ itemCode: "bedsheet", accepted: 2, damaged: 0, stained: 0 }] }, at(45 * DAY));
    const nextMonth = istMonthOf(at(40 * DAY));
    const next = await vendorMonthReport(db, v, nextMonth, at(75 * DAY));
    expect(next.reversals).toEqual([expect.objectContaining({ recoveryId: again.id, itemCode: "bedsheet", qty: 2, amountPaise: -80_000 })]);
    const credit = await raiseRecovery(db, d.desk, { linenVendorId: v, month: nextMonth }, at(75 * DAY));
    expect(credit.proposedPaise).toBe(-80_000);
    expect((await vendorMonthReport(db, v, nextMonth, at(75 * DAY))).reversals).toEqual([]);
  });

  it("spec #979 D4: a bill line for more pieces than were accepted is flagged; the payable is accepted pieces times the rate in force on the return date", async () => {
    const v = await vendor();
    const start = istDayOf;
    await setVendorRate(db, d.desk, { linenVendorId: v, itemCode: "bedsheet", ratePaise: 1200, effectiveFrom: start(at(-40 * DAY)) }, t0);
    await setVendorRate(db, d.desk, { linenVendorId: v, itemCode: "bedsheet", ratePaise: 1500, effectiveFrom: start(at(3 * DAY)) }, t0);
    const a = await challan(v, 10);
    await recordChallanReturn(db, d.desk, { challanId: a.challanId, lines: [{ itemCode: "bedsheet", accepted: 10, damaged: 0, stained: 0 }] }, at(2 * HOUR));
    const b = await challan(v, 6, at(5 * DAY));
    await recordChallanReturn(db, d.desk, { challanId: b.challanId, lines: [{ itemCode: "bedsheet", accepted: 5, damaged: 1, stained: 0 }] }, at(5 * DAY + 2 * HOUR));
    const bill = await checkVendorBill(db, d.desk, {
      linenVendorId: v, month, vendorBillNo: "CW/101", lines: [{ itemCode: "bedsheet", pieces: 16, amountPaise: 24_000 }], billedPaise: 28_320,
    }, at(35 * DAY));
    expect(bill.lines).toEqual([expect.objectContaining({ itemCode: "bedsheet", billed: 16, accepted: 15, flagged: true })]);
    expect(bill).toMatchObject({ acceptedValuePaise: 10 * 1200 + 5 * 1500, gstPaise: 3510, payablePaise: 23_010, heldPaise: 5310, state: "held" });
    await expect(approveBillExcess(db, d.desk, { billId: bill.id }, at(35 * DAY))).rejects.toMatchObject({ code: "approver_is_requester" });
    await expect(approveBillExcess(db, d.finance, { billId: bill.id }, at(35 * DAY))).rejects.toMatchObject({ code: "not_approver" });
    expect(await approveBillExcess(db, d.stores, { billId: bill.id }, at(35 * DAY))).toMatchObject({ state: "approved", payablePaise: 28_320 });
  });

  it("spec #979 D5: a uniform exchange gives one clean set only for one dirty set; a leaver's unreturned sets are on the no-dues list", async () => {
    await setUniformRole(db, d.desk, { roleKey: "nurse", entitled: true });
    await setLinenItemCost(db, s.supervisor, { itemCode: "uniform_set", pricePaise: 60_000 });
    const nurse = await mkUser(db, "u.nurse", ["nurse"]);
    const clerk = await mkUser(db, "u.clerk", ["front_office"]);
    await expect(issueUniform(db, d.desk, { userId: clerk.id, sets: 1, size: "M" }, t0)).rejects.toMatchObject({ code: "not_entitled" });
    await issueUniform(db, d.desk, { userId: nurse.id, sets: 3, size: "M" }, t0);
    await expect(issueUniform(db, d.desk, { userId: nurse.id, sets: 1, size: "M" }, t0)).rejects.toMatchObject({ code: "above_entitlement" });
    await expect(exchangeUniform(db, d.desk, { userId: nurse.id, dirty: 1, clean: 2 }, t0)).rejects.toMatchObject({ code: "one_for_one" });
    await expect(exchangeUniform(db, d.desk, { userId: clerk.id, dirty: 1, clean: 1 }, t0)).rejects.toMatchObject({ code: "exchange_unmatched" });
    expect(await exchangeUniform(db, d.desk, { userId: nurse.id, dirty: 1, clean: 1 }, t0)).toMatchObject({ holding: 3 });
    await returnUniform(db, d.desk, { userId: nurse.id, sets: 1 }, at(HOUR));
    expect(await uniformDues(db, at(2 * HOUR))).toEqual([]);
    await db.update(users).set({ active: false }).where(eq(users.id, nurse.id));
    const dues = await uniformDues(db, at(2 * HOUR));
    expect(dues).toEqual([expect.objectContaining({ userId: nurse.id, sets: 2, replacementPaise: 120_000 })]);
    expect(dues[0]!.deductionPaise).toBeLessThanOrEqual(120_000);
  });

  it("spec #979 D6: a tagged piece scanned at a round moves that piece; a hand count moves the same totals; a condemned piece's tag is refused", async () => {
    await registerPiece(db, d.desk, { itemCode: "bedsheet", tagUid: "RF-0001" });
    await registerPiece(db, d.desk, { itemCode: "bedsheet", tagUid: "RF-0002" });
    await expect(registerPiece(db, d.desk, { itemCode: "bedsheet", tagUid: "RF-0001" })).rejects.toMatchObject({ code: "tag_in_use" });
    await topUpWard(db, actorOf(H1), { wardId: h.generalWard, lines: [{ itemCode: "bedsheet", qty: 6 }] }, t0);
    const before = (await bookBalances(db, at(HOUR), h.generalWard)).get(h.generalWard)!.get("bedsheet")!.onHand;
    const r1 = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, t0);
    await signPickup(db, s.runner, { roundId: r1.id, pieceTags: ["RF-0001", "RF-0002"], runnerOnlyReason: "ward busy" }, at(HOUR));
    const tagged = await db.select().from(linenMovements).where(eq(linenMovements.roundId, r1.id));
    expect(tagged).toHaveLength(2);
    expect(tagged.every((m) => m.pieceId !== null && m.qty === 1 && m.kind === "return_soiled")).toBe(true);
    const r2 = await openRound(db, s.runner, { wardId: h.generalWard, kind: "pickup" }, t0);
    await signPickup(db, s.runner, { roundId: r2.id, lines: [{ itemCode: "bedsheet", qty: 2 }], runnerOnlyReason: "ward busy" }, at(HOUR));
    const after = (await bookBalances(db, at(2 * HOUR), h.generalWard)).get(h.generalWard)!.get("bedsheet")!.onHand;
    expect(before - after).toBe(4);
    // Condemn tag RF-0001 (four eyes); its tag is refused at the next count and cannot be registered again.
    const req = await requestCondemn(db, s.qc, { itemCode: "bedsheet", qty: 1, reason: "torn beyond mending", tag: "RF-0001" }, at(2 * HOUR));
    await approveCondemn(db, s.supervisor, { requestId: req.id }, at(2 * HOUR));
    await expect(sendToLaundry(db, s.operator, { infected: false, mode: "in_house", pieceTags: ["RF-0001"] }, at(3 * HOUR)))
      .rejects.toMatchObject({ code: "piece_condemned" });
    await expect(registerPiece(db, d.desk, { itemCode: "bedsheet", tagUid: "RF-0001" })).rejects.toMatchObject({ code: "piece_condemned" });
    const sent = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", pieceTags: ["RF-0002"] }, at(3 * HOUR));
    expect(sent.movements).toBe(1);
  });

  it("spec #979 D7: the plant read shows chemical issued per kg washed for the month, from stores issues to the laundry cost centre", async () => {
    const HEAD = actorOf("01HMATERIALSHEAD00000000001");
    const { itemId, storeId } = await withTx(db, async (tx) => ({
      itemId: (await registerItem(tx, HEAD, { code: "DET-1", name: "Laundry detergent", class: "consumable", baseUom: "kg", batchTracked: false, gstRateBps: 1800, uoms: [] })).itemId,
      storeId: (await createStore(tx, HEAD, { code: "MAIN-ST", name: "Main store" })).resourceId,
    }));
    const batchId = newId();
    await db.insert(stockBatches).values({ id: batchId, itemId, batchNo: "D1", landedCostPaise: 10_000, ownership: "owned", createdBy: HEAD.id });
    await withTx(db, async (tx) => {
      await postMovement(tx, HEAD, { resourceId: storeId, batchId, qtyDelta: 10, reason: "grn", refType: "test", refId: batchId, occurredAt: t0 });
      await postMovement(tx, HEAD, { resourceId: storeId, batchId, qtyDelta: -4, reason: "consume", costCenter: "laundry", refType: "test", refId: batchId, occurredAt: at(HOUR) });
    });
    const washer = await addMachine(db, s.operator, { code: "W1", kind: "washer", name: "Washer 1" }, t0);
    await soiled(20);
    const b1 = await sendToLaundry(db, s.operator, { infected: false, mode: "in_house", lines: [{ itemCode: "bedsheet", qty: 20 }] }, t0);
    const c1 = await startCycle(db, s.operator, { machineId: washer.id, batchIds: [b1.batchId!], program: "normal" }, at(HOUR));
    await finishCycle(db, s.operator, { cycleId: c1.id, tempC: 60, holdMin: 10, chemical: "detergent", loadGrams: 80_000 }, at(2 * HOUR));
    await releaseBatch(db, s.operator, { batchId: b1.batchId! }, at(2 * HOUR));
    // The vendor's per-kg cost beside it: 10 accepted at ₹12 for 20 kg sent.
    const v = await vendor();
    await setVendorRate(db, d.desk, { linenVendorId: v, itemCode: "bedsheet", ratePaise: 1200, effectiveFrom: istDayOf(at(-40 * DAY)) }, t0);
    await soiled(10);
    const vb = await sendToLaundry(db, d.desk, { infected: false, mode: "vendor", linenVendorId: v, weightGrams: 20_000, lines: [{ itemCode: "bedsheet", qty: 10 }] }, t0);
    await recordChallanReturn(db, d.desk, { challanId: (await challanFor(db, vb.batchId!))!.id, lines: [{ itemCode: "bedsheet", accepted: 10, damaged: 0, stained: 0 }] }, at(3 * HOUR));
    const use = await chemicalUse(db, month);
    expect(use.kgWashed).toBe(80);
    expect(use.items).toEqual([expect.objectContaining({ itemId, qty: 4, costPaise: 40_000, perKg: 0.05, costPerKgPaise: 500 })]);
    expect(use).toMatchObject({ inHouseCostPerKgPaise: 500, vendorCostPerKgPaise: 600 });
  });

  it("spec #979 D8: the wastewater consent and the boiler licence are on the compliance calendar with their expiry, red within 60 days", async () => {
    const day = istDayOf;
    await fileLicence(db, d.desk, { kind: "etp_consent", licenceNo: "SPCB/ETP/1", authority: "State Pollution Control Board", validFrom: day(at(-300 * DAY)), validTo: day(at(45 * DAY)) }, t0);
    await fileLicence(db, d.desk, { kind: "boiler", licenceNo: "IBR/77", authority: "Inspector of Boilers", validFrom: day(at(-100 * DAY)), validTo: day(at(200 * DAY)) }, t0);
    const cal = await licenceCalendar(db, t0);
    expect(cal.map((r) => [r.kind, r.licenceNo, r.validTo, r.state])).toEqual([
      ["etp_consent", "SPCB/ETP/1", day(at(45 * DAY)), "red"],
      ["boiler", "IBR/77", day(at(200 * DAY)), "ok"],
    ]);
    expect(cal[0]!.daysLeft).toBeLessThanOrEqual(60);
    expect((await licenceCalendar(db, at(201 * DAY))).find((r) => r.kind === "boiler")).toMatchObject({ state: "expired" });
  });
});
