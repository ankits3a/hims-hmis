import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, MON2, addAllergy, issueRx, line, reissueRx, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, orderItems, orders, pharmacyDispenseLines, pharmacyDispenses, workflowInstances } from "../../kernel/db/schema";
import { claimDispense, findAtCounter } from "./claim";
import { handlePrescriptionIssued } from "./consumers";
import { getDispense, listQueue } from "./queue";
import { alternativesFor, cancelDispense, declineLine, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16c T3 — the counter's first half, end to end against the database: find (three doors),
 * claim (A1: one winner), verify (the order placed, the re-check, substitution), decline, cancel,
 * and the `prescription.issued` consumer.
 */
describe("the dispense counter — find, claim, verify (16c T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  async function scanned(qrPayload: string): Promise<string> {
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error(`expected a dispense, got ${JSON.stringify(r)}`);
    return r.dispense.id;
  }

  it("D4 — the three doors resolve one Rx to ONE queued dispense; a bad QR and a stranger resolve to none", async () => {
    const { issued, tokenNo } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const byQr = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    expect(byQr.kind).toBe("dispense");
    if (byQr.kind !== "dispense") return;
    expect(byQr.door).toBe("rx_qr");
    expect(byQr.dispense.status).toBe("queued");
    expect(byQr.dispense.patient.uhid).toBe(fx.patient.uhid);

    const byToken = await findAtCounter(db, testCfg, fx.pharmacist.actor, `T-${String(tokenNo)}`, MON2);
    expect(byToken.kind === "dispense" && byToken.door === "token" && byToken.dispense.id === byQr.dispense.id).toBe(true);
    const byUhid = await findAtCounter(db, testCfg, fx.pharmacist.actor, fx.patient.uhid, MON2);
    expect(byUhid.kind === "dispense" && byUhid.door === "uhid" && byUhid.dispense.id === byQr.dispense.id).toBe(true);
    expect(await db.select().from(pharmacyDispenses)).toHaveLength(1); // three doors, one row

    expect(await findAtCounter(db, testCfg, fx.pharmacist.actor, "rx1.forged.payload.1.sig", MON2)).toEqual({ kind: "none", door: "rx_qr", reason: "qr_invalid" });
    expect(await findAtCounter(db, testCfg, fx.pharmacist.actor, "T-99", MON2)).toEqual({ kind: "none", door: "token", reason: "not_found" });
    expect((await findAtCounter(db, testCfg, fx.pharmacist.actor, "ZZ-NOBODY", MON2)).kind).toBe("none");

    const queue = await listQueue(db, fx.pharmacist.actor, { serviceDate: "2026-08-17" });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ dispenseId: byQr.dispense.id, status: "queued", lineCount: 0, patient: { uhid: fx.patient.uhid } });
  });

  it("A1 — two counters claim the same queued dispense concurrently: ONE claims, the other is refused, lines are written once", async () => {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin }), line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })]);
    const id = await scanned(issued.qrPayload);
    const results = await Promise.allSettled([
      claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2),
      claimDispense(db, fx.aide.actor, { dispenseId: id, door: "rx_qr" }, MON2),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ code: "dispense_not_in_state" });
    expect(await db.select().from(pharmacyDispenseLines)).toHaveLength(2);
    const d = await getDispense(db, fx.pharmacist.actor, id);
    expect(d.status).toBe("claimed");
    expect(d.scheduled).toBe(true); // the H1 line
    expect(d.storeResourceId).toBe(fx.storeId);
    expect(d.lines.map((l) => [l.lineIdx, l.qtyBase, l.scheduleFlag, l.substitutionType, l.saleable])).toEqual([
      [0, 15, "OTC", "none", true], [1, 3, "H1", "none", true],
    ]);
    const row = (await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id)))[0]!;
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, row.workflowInstanceId!));
    expect(inst).toMatchObject({ currentState: "claimed" });
    expect(await db.select().from(events).where(eq(events.name, "dispense.claimed"))).toHaveLength(1);
  });

  it("claim lays the lines out: a free-text line resolves exactly or stays unresolved; Schedule X refuses the whole claim (R-3)", async () => {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500" }), line({ drug: "Tab Mystery 10mg" })]);
    const id = await scanned(issued.qrPayload);
    const d = await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    expect(d.lines[0]).toMatchObject({ substitutionType: "resolved", dispensedMedicine: { id: fx.med.crocin }, item: { code: "CROC500" }, saleable: true, available: 0 });
    expect(d.lines[1]).toMatchObject({ substitutionType: "none", dispensedMedicine: null, item: null, saleable: false });

    const x = await issueRx(db, fx, [line({ drug: "Alprax 0.5", medicineId: fx.med.alprax })], { at: MON2 });
    const xid = await scanned(x.issued.qrPayload);
    await expect(claimDispense(db, fx.pharmacist.actor, { dispenseId: xid, door: "rx_qr" }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "schedule_x_not_dispensed_here", detail: { lineIdx: 0, scheduleFlag: "X" } }));
    expect((await getDispense(db, fx.pharmacist.actor, xid)).status).toBe("queued");
  });

  it("verify places the medication order on the P series with one item per open line, and settles substitution", async () => {
    const { issued, encounter } = await issueRx(db, fx, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
      line({ drug: "Tab Mystery 10mg" }),
    ]);
    const id = await scanned(issued.qrPayload);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    // an unresolved line blocks verify until it is declined
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }, { lineIdx: 1, qtyBase: 3 }, { lineIdx: 2, qtyBase: 1 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "unresolved_medicine" }));
    await declineLine(db, fx.pharmacist.actor, fx.decls, id, 2, "not stocked here", MON2);
    // the screen's offer is verify's rule: Crocin's only equivalent on the shelf is Calpol; Azee has none
    expect((await alternativesFor(db, id, 0)).map((a) => a.itemCode)).toEqual(["CALP500"]);
    expect(await alternativesFor(db, id, 1)).toEqual([]);
    // a generic substitute needs consent; a different medicine is refused
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15, dispensedMedicineId: fx.med.calpol }, { lineIdx: 1, qtyBase: 3 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "consent_required" }));
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15, dispensedMedicineId: fx.med.ibuprofen, patientConsent: true }, { lineIdx: 1, qtyBase: 3 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "substitution_not_allowed" }));

    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 20, dispensedMedicineId: fx.med.calpol, patientConsent: true }, { lineIdx: 1, qtyBase: 3 }] }, MON2);
    expect(v.status).toBe("verified");
    expect(v.dispenseNo).toMatch(/^P/);
    expect(v.scheduled).toBe(true);
    expect(v.lines[0]).toMatchObject({ qtyBase: 20, substitutionType: "generic", dispensedMedicine: { id: fx.med.calpol }, item: { code: "CALP500" } });
    expect(v.lines[2]).toMatchObject({ status: "declined", declinedReason: "not stocked here", orderItemId: null });

    const [order] = await db.select().from(orders).where(eq(orders.id, v.orderId!));
    expect(order).toMatchObject({ kind: "medication", orderNo: v.dispenseNo, patientId: fx.patient.id, orderingClinicianId: fx.doctor.doctorId });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, v.orderId!));
    expect(items).toHaveLength(2); // the declined line never reached the envelope
    expect(items.every((i) => i.status === "placed")).toBe(true);
    expect(v.lines.filter((l) => l.status === "open").map((l) => l.orderItemId).sort()).toEqual(items.map((i) => i.id).sort());
    expect(await db.select().from(events).where(eq(events.name, "substitution.recorded"))).toHaveLength(1);
    const [verified] = await db.select().from(events).where(eq(events.name, "dispense.verified"));
    expect(verified?.payload).toMatchObject({ lineCount: 2, declinedCount: 1, substitutions: 1, scheduled: true, encounterId: encounter.id });
  });

  it("D9 — an allergy recorded AFTER the Rx was issued blocks verify; the prescriber's override at issue time lets it through", async () => {
    const later = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const id = await scanned(later.issued.qrPayload);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await addAllergy(db, fx.patient.id, "Paracetamol");
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("claimed");

    // The doctor re-issues THROUGH the allergy with a reason: the counter re-runs that decision, it does not re-make it.
    const overridden = await reissueRx(db, fx, later.encounter.id, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], {
      overrides: { overrides: [{ lineIndex: 0, substance: "Paracetamol", reason: "tolerated before; mild rash only" }] },
    });
    expect(overridden.version).toBe(2);
    const id2 = await scanned(overridden.qrPayload);
    expect(id2).not.toBe(id);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id2, door: "rx_qr" }, MON2);
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id2, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    expect(v.status).toBe("verified");
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.verified"));
    expect(ev?.payload).toMatchObject({ allergyHits: 1 });
    // and the superseded v1 dispense can no longer be verified
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "prescription_superseded" }));
  });

  it("cancel after verify cancels the envelope's items and closes the instance; queued rows cancel plainly", async () => {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const id = await scanned(issued.qrPayload);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    const c = await cancelDispense(db, fx.pharmacist.actor, fx.decls, id, "patient left without paying", MON2);
    expect(c.status).toBe("cancelled");
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, v.orderId!));
    expect(items.map((i) => i.status)).toEqual(["cancelled"]);
    const row = (await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id)))[0]!;
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, row.workflowInstanceId!));
    expect(inst?.currentState).toBe("cancelled");
    await expect(cancelDispense(db, fx.pharmacist.actor, fx.decls, id, "again", MON2)).rejects.toThrow(expect.objectContaining({ code: "dispense_not_in_state" }));
    // a cancelled dispense frees the (prescription, version) slot: the next scan queues a fresh row
    const again = await scanned(issued.qrPayload);
    expect(again).not.toBe(id);
    expect((await getDispense(db, fx.pharmacist.actor, again)).status).toBe("queued");
  });

  it("D10 — the prescription.issued consumer queues once, ignores a replay, and a re-issue supersedes the queued v1", async () => {
    const first = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const [ev1] = await db.select().from(events).where(eq(events.name, "prescription.issued"));
    const r1 = await withTx(db, (tx) => handlePrescriptionIssued(tx, ev1!.eventId, ev1!.payload, MON2));
    expect(r1.handled).toBe(true);
    expect(r1.dispenseId).not.toBeNull();
    const replay = await withTx(db, (tx) => handlePrescriptionIssued(tx, ev1!.eventId, ev1!.payload, MON2));
    expect(replay).toEqual({ handled: false, dispenseId: null });
    expect(await db.select().from(pharmacyDispenses)).toHaveLength(1);
    // a scan of the same Rx finds the consumer's row, it does not make a second
    expect(await scanned(first.issued.qrPayload)).toBe(r1.dispenseId);

    const second = await reissueRx(db, fx, first.encounter.id, [line({ drug: "Calpol 500", medicineId: fx.med.calpol })]);
    const evs = await db.select().from(events).where(eq(events.name, "prescription.issued"));
    const ev2 = evs.find((e) => (e.payload as { version: number }).version === 2)!;
    const r2 = await withTx(db, (tx) => handlePrescriptionIssued(tx, ev2.eventId, ev2.payload, MON2));
    const rows = await db.select().from(pharmacyDispenses);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === r1.dispenseId)).toMatchObject({ status: "cancelled", cancelReason: "superseded by version 2" });
    expect(rows.find((r) => r.id === r2.dispenseId)).toMatchObject({ status: "queued", prescriptionVersion: 2 });
    expect(second.version).toBe(2);
    expect(await db.select().from(events).where(eq(events.name, "dispense.queued"))).toHaveLength(2);
  });
});
