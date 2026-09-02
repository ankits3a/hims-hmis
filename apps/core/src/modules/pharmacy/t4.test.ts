import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, orderItems, pharmacyRegH1, stockBalances, stockLedger } from "../../kernel/db/schema";
import { setPriceRegulation } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { labelFor } from "./label";
import { pickDispense } from "./pick";
import { getDispense } from "./queue";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DispenseView } from "./queue";

/**
 * PLAN 16c T4 — pick, bill, hand over. Stock: Crocin in two batches (the earlier-expiring one
 * created SECOND, so creation order cannot stand in for FEFO — Plan 14 A10's fixture), Azee in one
 * batch whose printed MRP is ABOVE its notified ceiling (R-1: the ceiling wins, on the invoice).
 */
describe("the dispense counter — pick, bill, hand over (16c T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let crocinLate: string;
  let crocinEarly: string;
  let azeeBatch: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    crocinLate = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-LATE", expiryDate: "2027-12-31", qtyBase: 100, mrpPaise: 12000 });
    crocinEarly = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-EARLY", expiryDate: "2027-01-31", qtyBase: 40, mrpPaise: 12000 });
    azeeBatch = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 6, mrpPaise: 15000 });
    // NPPA ceiling for azithromycin: ₹100 a strip of 10 → 1000 paise a tablet, BELOW the printed ₹150
    await withTx(db, (tx) => setPriceRegulation(tx, fx.pharmacist.actor, fx.item.azithro, { ceilingPaise: 10000, mrpUom: "strip", effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "S.O. test" }));
  });
  afterEach(() => { fx.unregister(); });

  async function verified(lines: Parameters<typeof issueRx>[2], qty: number[]): Promise<DispenseView> {
    const { issued } = await issueRx(db, fx, lines);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    return verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: qty.map((q, i) => ({ lineIdx: i, qtyBase: q })) }, MON2);
  }
  const twoLines = () => [line({ drug: "Crocin 500", medicineId: fx.med.crocin }), line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })];

  it("pick takes the EARLIEST-expiring batch, holds a reservation per line, and moves the envelope to in_progress", async () => {
    const v = await verified(twoLines(), [20, 3]);
    const p = await pickDispense(db, fx.pharmacist.actor, fx.decls, v.id, {}, MON2);
    expect(p.status).toBe("picked");
    expect(p.lines[0]).toMatchObject({ batchId: crocinEarly, qtyBase: 20 });
    expect(p.lines[1]).toMatchObject({ batchId: azeeBatch, qtyBase: 3 });
    expect(p.lines.every((l) => l.reservationId !== null)).toBe(true);
    const [early] = await db.select().from(stockBalances).where(eq(stockBalances.batchId, crocinEarly));
    expect(early).toMatchObject({ qtyOnHand: 40, qtyReserved: 20 });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, v.orderId!));
    expect(items.map((i) => i.status)).toEqual(["in_progress", "in_progress"]);
    expect(p.lines[0]!.available).toBe(20 + 100); // what is left across both batches, reservation deducted
  });

  it("short stock: the pharmacist dispenses a partial quantity with a reason, or names a later batch that covers it (an override, evented)", async () => {
    const v = await verified([line({ drug: "Crocin 500", medicineId: fx.med.crocin, durationDays: 20 })], [60]);
    await expect(pickDispense(db, fx.pharmacist.actor, fx.decls, v.id, {}, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "short_stock", detail: expect.objectContaining({ lineIdx: 0, available: 140 }) }));
    await expect(pickDispense(db, fx.pharmacist.actor, fx.decls, v.id, { lines: [{ lineIdx: 0, qtyBase: 40 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "qty_required" })); // a partial needs its reason
    const p = await pickDispense(db, fx.pharmacist.actor, fx.decls, v.id, { lines: [{ lineIdx: 0, batchId: crocinLate }] }, MON2);
    expect(p.lines[0]).toMatchObject({ batchId: crocinLate, qtyBase: 60 });
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.picked"));
    expect(ev?.payload).toMatchObject({ lines: [{ lineIdx: 0, batchId: crocinLate, qtyBase: 60, fefoOverride: true }] });

    const v2 = await verified([line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 10 })], [10]);
    const partial = await pickDispense(db, fx.pharmacist.actor, fx.decls, v2.id, { lines: [{ lineIdx: 0, qtyBase: 6, pickNote: "only 6 left; balance from tomorrow's delivery" }] }, MON2);
    expect(partial.lines[0]).toMatchObject({ batchId: azeeBatch, qtyBase: 6 });
  });

  it("R-1 — the bill prices each line from its batch: MRP per tablet where nothing caps it, the NPPA ceiling where it is lower; totals to the paisa", async () => {
    const v = await verified(twoLines(), [20, 3]);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, v.id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, v.id, MON2);
    // Crocin: 20 × 1200 = 24000 gross, 12% GST → 26880. Azee: 3 × 1000 (ceiling, not the 1500 MRP) = 3000, 5% → 3150.
    expect(preview.lines.map((l) => [l.unitPaise, l.grossPaise, l.netPaise])).toEqual([[1200, 24000, 26880], [1000, 3000, 3150]]);
    expect(preview.lines[1]!.regulatedClamp).toMatchObject({ boundApplied: "caller_cap", capUnitPaise: 1000, batchUnitPaise: 1500 });
    expect(preview.totals.rawTotalPaise).toBe(30030);

    const b = await billDispense(db, fx.pharmacist.actor, v.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    expect(b.status).toBe("billed");
    expect(b.invoiceId).not.toBeNull();
    expect(b.lines.map((l) => [l.unitPaise, l.priceWinner])).toEqual([[1200, "batch_mrp"], [1000, "ceiling"]]);
    expect(b.lines.every((l) => l.invoiceLineId !== null)).toBe(true);
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.billed"));
    expect(ev?.payload).toMatchObject({ invoiceId: b.invoiceId, netPaise: preview.totals.netPayablePaise });
    // the bill is once: a second call finds the dispense billed, not picked
    await expect(billDispense(db, fx.pharmacist.actor, v.id, { tenders: [{ mode: "cash", amountPaise: 1 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "dispense_not_in_state" }));
  });

  it("hand over: the aide cannot complete an H1 dispense, identity is confirmed, the ledger is debited, the envelope closes, the H1 register is written", async () => {
    const { issued, tokenNo } = await issueRx(db, fx, twoLines());
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.aide.actor, { dispenseId: id, door: "rx_qr" }, MON2); // the aide may claim
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 20 }, { lineIdx: 1, qtyBase: 3 }] }, MON2);
    await pickDispense(db, fx.aide.actor, fx.decls, id, {}, MON2); // and pick
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);

    await expect(handOverDispense(db, fx.aide.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) } }, MON3))
      .rejects.toThrow(expect.objectContaining({ code: "scheduled_needs_pharmacist" }));
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3))
      .rejects.toThrow(expect.objectContaining({ code: "identity_confirmation_required" }));
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "0000" } }, MON3))
      .rejects.toThrow(expect.objectContaining({ code: "identity_mismatch" }));
    expect(await db.select().from(stockLedger).where(eq(stockLedger.reason, "consume"))).toHaveLength(0); // nothing moved on a refusal

    const h = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "3210" } }, MON3);
    expect(h.status).toBe("handed_over");
    expect(h.identityConfirmedVia).toBe("phone_last4");
    expect(h.lines.every((l) => l.ledgerEntryId !== null)).toBe(true);

    const consumed = await db.select().from(stockLedger).where(eq(stockLedger.reason, "consume"));
    expect(consumed).toHaveLength(2);
    expect(consumed.map((c) => [c.batchId, c.qtyDelta, c.patientId, c.refType]).sort()).toEqual([[azeeBatch, -3, fx.patient.id, "pharmacy_dispense"], [crocinEarly, -20, fx.patient.id, "pharmacy_dispense"]].sort());
    const [early] = await db.select().from(stockBalances).where(eq(stockBalances.batchId, crocinEarly));
    expect(early).toMatchObject({ qtyOnHand: 20, qtyReserved: 0 });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, h.orderId!));
    expect(items.map((i) => i.status)).toEqual(["completed", "completed"]);

    const reg = await db.select().from(pharmacyRegH1);
    expect(reg).toHaveLength(1); // the H1 line only
    expect(reg[0]).toMatchObject({ patientName: "Asha Devi", prescriberName: "Dr dr.sen", drugName: "Azee 500 500 mg tablet", batchNo: "AZ-1", qtyBase: 3, unit: "tablet" });
    const consumedEvents = await db.select().from(events).where(eq(events.name, "material.consumed"));
    expect(consumedEvents).toHaveLength(2);
    expect(consumedEvents.map((e) => (e.payload as { caseRef: { type: string } }).caseRef.type)).toEqual(["pharmacy_dispense", "pharmacy_dispense"]);
    expect(consumedEvents.find((e) => (e.payload as { batchId: string }).batchId === azeeBatch)?.payload).toMatchObject({ mrpPaisePerBase: 1500, ceilingPaisePerBase: 1000, qtyBase: 3 });
    const [hand] = await db.select().from(events).where(eq(events.name, "dispense.handed_over"));
    expect(hand?.payload).toMatchObject({ h1RegisterRows: 1, identityConfirmedVia: "phone_last4" });
    expect((hand?.payload as { ledgerEntryIds: string[] }).ledgerEntryIds).toHaveLength(2);

    const label = await labelFor(db, fx.pharmacist.actor, id);
    expect(label.lines.map((l) => [l.drug, l.qtyBase, l.packs, l.batchNo, l.expiryDate])).toEqual([
      ["Crocin 500", 20, "2 strip", "CR-EARLY", "2027-01-31"], ["Azee 500", 3, null, "AZ-1", "2027-06-30"],
    ]);
    expect(label.lines[0]!.directions).toBe("1 tab · TDS · 5 days");
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("handed_over");
  });

  it("an OTC-only dispense needs no pharmacist and no identity confirmation; the token door also confirms", async () => {
    const { issued, tokenNo } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.aide.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    // verify PLACES the order, which needs the kernel's orders.place — the pharmacist's, never the aide's
    await expect(verifyDispense(db, fx.aide.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "permission_denied" }));
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.aide.actor, fx.decls, r.dispense.id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, r.dispense.id, MON2);
    await billDispense(db, fx.pharmacist.actor, r.dispense.id, { tenders: [{ mode: "upi", amountPaise: preview.totals.netPayablePaise, refText: "UPI-1" }] }, MON2);
    const h = await handOverDispense(db, fx.aide.actor, fx.decls, r.dispense.id, {}, MON3);
    expect(h.status).toBe("handed_over");
    expect(h.identityConfirmedVia).toBeNull();
    expect(await db.select().from(pharmacyRegH1)).toHaveLength(0);

    // the token door, on a scheduled dispense
    const s = await verified(twoLines(), [20, 3]);
    void tokenNo;
    await pickDispense(db, fx.pharmacist.actor, fx.decls, s.id, {}, MON2);
    const p2 = await previewDispenseBill(db, fx.pharmacist.actor, s.id, MON2);
    await billDispense(db, fx.pharmacist.actor, s.id, { tenders: [{ mode: "cash", amountPaise: p2.totals.netPayablePaise }] }, MON2);
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, s.id, { identity: { via: "token", value: "T-99" } }, MON3))
      .rejects.toThrow(expect.objectContaining({ code: "identity_mismatch" }));
  });
});
