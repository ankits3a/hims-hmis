import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  events, invoices, ipdAdmissions, ipdChargeExceptions, ipdChargeLines, ipdFinalBills, patients, stockBalances, stockBatches, stockLedger,
} from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkEmarWorld } from "../../../../test/helpers/ipd";
import { BillingError, previewInvoice } from "../../billing";
import { postMovement } from "../../materials";
import { gstCategoryMap, invoiceInputsOf, priceBatchLine } from "../../pharmacy";
import { upsertGstCategory } from "../../tariff";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ipdManifest } from "../manifest";
import {
  IpdError, IpdRefusal, counterCharge, counterReturn, lookupCounterAdmission, readCounterSales, readEmarPatient, readInterimBill, registerIpdOrderChargeSink,
  reverseChargeLine,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { EmarWorld } from "../../../../test/helpers/ipd";
import type { Actor } from "@hmis/contracts";

/**
 * #787 (IP counter) — CHARGE TO IP AT THE OPD PHARMACY COUNTER. Each `it` is one rule of the item: the lookup by IP number
 * or UHID with the bed and the ward, the ward issue's own price and charge path, the refusals, the returns and the audit.
 * Explicit IST instants; nothing reads the clock for a date. The shelf: a strip of 10 at MRP ₹10.00 (100 paise a tablet,
 * GST 12 % inside the MRP), unless a test adds its own batch.
 */
jest.setTimeout(300_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = () => randomUUID();
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const UNIT = 100;
const SALE_AT = ist("2026-03-11T11:00:00");

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    if (e instanceof IpdRefusal || e instanceof IpdError || e instanceof BillingError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("#787 (IP counter) — an OPD pharmacy counter sale charged to the IP admission", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: EmarWorld;
  const off: (() => void)[] = [];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkEmarWorld(db);
    await withTx(db, (tx) => upsertGstCategory(tx, w.tariffDrafter, { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null }));
    const registry = new ModuleRegistry();
    registry.install(ipdManifest);
    await syncPermissions(db, registry);
    off.push(registerIpdOrderChargeSink());
  });
  afterEach(() => { while (off.length > 0) off.pop()!(); });

  const lines = async (admissionId: string) => (await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId))
    .orderBy(asc(ipdChargeLines.postedAt), asc(ipdChargeLines.drugSeq), asc(ipdChargeLines.id))).filter((l) => l.component === "pharmacy");
  const live = async (admissionId: string) => {
    const all = await lines(admissionId);
    const gone = new Set(all.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
    return all.filter((l) => l.reversalOf === null && !gone.has(l.id));
  };
  const onHand = async (batchId: string) => (await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, w.storeId), eq(stockBalances.batchId, batchId))))[0]?.qtyOnHand ?? 0;
  const addBatch = async (itemId: string, opts: { mrpPaise: number | null; qty: number; expiry: string }) => {
    const batchId = newId();
    await db.insert(stockBatches).values({
      id: batchId, itemId, batchNo: `IC-${batchId.slice(-6)}`, expiryDate: opts.expiry, mrpPaise: opts.mrpPaise, mrpUom: opts.mrpPaise === null ? null : "strip",
      landedCostPaise: 500, ownership: "owned", createdBy: HEAD.id,
    } as never);
    await withTx(db, (tx) => postMovement(tx, HEAD, { resourceId: w.storeId, batchId, qtyDelta: opts.qty, reason: "grn", refType: "test", refId: batchId, occurredAt: new Date("2026-01-01T00:00:00Z") }));
    return batchId;
  };
  const admitted = async () => {
    const r = await w.admitMed(ist("2026-03-10T10:00:00"));
    const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, r.admissionId)))[0]!;
    const uhid = (await db.select({ uhid: patients.uhid }).from(patients).where(eq(patients.id, r.patientId)))[0]!.uhid;
    return { ...r, admissionNo: a.admissionNo!, uhid };
  };
  const charge = (admissionId: string, sold: { medicineId: string; units: number; batchId?: string }[], at: Date = SALE_AT, k: string = key()) =>
    counterCharge(db, w.pharmacist, { idempotencyKey: k, admissionId, lines: sold }, { now: at });
  const giveBack = (saleId: string, itemId: string, units: number, at: Date) =>
    counterReturn(db, w.pharmacist, { idempotencyKey: key(), saleId, itemId, units, reason: "Not needed" }, { now: at });
  const settleBillOver = async (admissionId: string, lineIds: string[], at: Date) => {
    await db.insert(ipdFinalBills).values({
      id: newId(), admissionId, billVersion: lineIds.length, totalPaise: 0, payerPaise: 0, patientPaise: 0, depositAppliedPaise: 0, paidPaise: 0,
      refundPaise: 0, duesPaise: 0, settlement: "paid", split: {}, settledBy: w.billDesk.id, settledAt: at, kind: "final", seq: 0, lineIds,
    } as never);
  };

  it("finds the admission by IP number or by UHID, and shows the bed and the ward the eMAR shows", async () => {
    const r = await admitted();
    const byIp = await lookupCounterAdmission(db, w.pharmacist, ` ${r.admissionNo.toLowerCase()} `, { now: SALE_AT });
    const byUhid = await lookupCounterAdmission(db, w.pharmacist, r.uhid, { now: SALE_AT });
    expect(byUhid).toEqual(byIp);
    const mar = await readEmarPatient(db, w.pharmacist, r.admissionId, { now: SALE_AT });
    expect([byIp.admissionId, byIp.admissionNo, byIp.state, byIp.identity.uhid]).toEqual([r.admissionId, r.admissionNo, "admitted", r.uhid]);
    expect(byIp.bedCode).not.toBeNull();
    expect(byIp.wardName).not.toBeNull();
    expect([byIp.bedCode, byIp.wardName]).toEqual([mar.bedCode, mar.wardName]);
  });

  it("charges each sold batch to the running bill at the ward issue's own price; stock leaves PHARM-OPD; no invoice, no cash", async () => {
    const r = await admitted();
    const med = await w.stocked("Countermox 500", { qty: 4 });
    const later = await addBatch(med.itemId, { mrpPaise: 1200, qty: 50, expiry: "2031-06-30" });
    const sale = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 10 }]);

    const posted = await lines(r.admissionId);
    expect(posted.map((l) => [l.source, l.orderId, l.issueId, l.batchId, l.qty, l.drugSeq, l.serviceDate]).sort()).toEqual([
      ["ipd.pharmacy", sale.saleId, sale.saleId, med.batchId, 4, 0, "2026-03-11"],
      ["ipd.pharmacy", sale.saleId, sale.saleId, later, 6, 0, "2026-03-11"],
    ].sort());
    const gst = await gstCategoryMap(db);
    for (const l of posted) {
      const priced = await priceBatchLine(db, gst, { itemId: med.itemId, batchId: l.batchId!, qtyBase: l.qty }, SALE_AT);
      const counter = await previewInvoice(db, { lines: invoiceInputsOf(priced), roundingRule: "exact" }, SALE_AT);
      expect([l.unitPaise, l.grossPaise, l.netPaise]).toEqual([counter.lines[0]!.unitPaise, counter.totals.grossPaise, counter.totals.rawTotalPaise]);
    }
    expect(sale).toEqual({ saleId: sale.saleId, admissionId: r.admissionId, lines: [{ medicineId: med.medicineId, units: 10, netPaise: 4 * UNIT + 6 * 120 }], totalPaise: 4 * UNIT + 6 * 120 });
    expect([await onHand(med.batchId), await onHand(later)]).toEqual([0, 44]);
    const ledger = await db.select().from(stockLedger).where(eq(stockLedger.refId, sale.saleId));
    expect(ledger.map((m) => [m.refType, m.reason, m.resourceId, m.encounterId, m.patientId, m.actorId])).toEqual(ledger.map(() =>
      ["ipd_counter_sale", "consume", w.storeId, r.admissionId, r.patientId, w.pharmacist.id]));
    expect(await db.select().from(invoices).where(eq(invoices.patientId, r.patientId))).toEqual([]);
    // On the interim bill with the ward's medicines.
    const interim = await readInterimBill(db, w.billDesk, r.admissionId);
    expect(interim.byComponent.find((c) => c.component === "pharmacy")).toEqual({ component: "pharmacy", netPaise: 4 * UNIT + 6 * 120 });
  });

  it("audits every sale: one event naming the pharmacist, the admission, the sale, its charge lines and its total", async () => {
    const r = await admitted();
    const med = await w.stocked("Auditol 500");
    const sale = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 3 }]);
    const rows = await db.select().from(events).where(eq(events.name, "ipd.med.counter_charged"));
    expect(rows.map((e) => [e.actorId, e.patientId, e.encounterId])).toEqual([[w.pharmacist.id, r.patientId, r.admissionId]]);
    const ids = (await lines(r.admissionId)).map((l) => l.id);
    expect(rows[0]!.payload).toMatchObject({ saleId: sale.saleId, admissionId: r.admissionId, storeId: w.storeId, lines: 1, units: 3, chargeLineIds: ids, totalPaise: 3 * UNIT });
  });

  it("a retried sale (the same key) charges once", async () => {
    const r = await admitted();
    const med = await w.stocked("Retrycin 500");
    const k = key();
    const one = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 2 }], SALE_AT, k);
    const two = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 2 }], SALE_AT, k);
    expect(two.saleId).toBe(one.saleId);
    expect(await lines(r.admissionId)).toHaveLength(1);
  });

  it("refuses a patient not admitted, a discharged stay and a settled final bill — at the lookup and at the charge; nothing moves", async () => {
    const r = await admitted();
    const med = await w.stocked("Refusol 500", { qty: 20 });
    const tryBoth = async () => [
      await codeOf(lookupCounterAdmission(db, w.pharmacist, r.admissionNo, { now: SALE_AT })),
      await codeOf(charge(r.admissionId, [{ medicineId: med.medicineId, units: 2 }])),
    ];
    // Admission asked for, not yet in a bed.
    await db.update(ipdAdmissions).set({ state: "requested" }).where(eq(ipdAdmissions.id, r.admissionId));
    expect(await tryBoth()).toEqual(["not_admitted", "not_admitted"]);
    expect(await codeOf(lookupCounterAdmission(db, w.pharmacist, r.uhid, { now: SALE_AT }))).toBe("not_admitted");
    // The stay ended.
    await db.update(ipdAdmissions).set({ state: "discharged" }).where(eq(ipdAdmissions.id, r.admissionId));
    expect(await tryBoth()).toEqual(["ip_discharged", "ip_discharged"]);
    // In the bed, but the final bill is settled: the supplementary bill (through the ward) or a cash sale.
    await db.update(ipdAdmissions).set({ state: "discharging" }).where(eq(ipdAdmissions.id, r.admissionId));
    await settleBillOver(r.admissionId, [], ist("2026-03-11T10:00:00"));
    expect(await tryBoth()).toEqual(["ip_bill_settled", "ip_bill_settled"]);
    // A UHID nobody has, and an IP number nobody has.
    expect(await codeOf(lookupCounterAdmission(db, w.pharmacist, "ZZ00000000", { now: SALE_AT }))).toBe("not_admitted");
    expect(await codeOf(lookupCounterAdmission(db, w.pharmacist, "IP26-999999", { now: SALE_AT }))).toBe("admission_not_found");
    expect(await lines(r.admissionId)).toEqual([]);
    expect(await onHand(med.batchId)).toBe(20);
  });

  it("refuses a controlled drug (ward order only), a missing price (never ₹0) and short stock; the whole sale rolls back", async () => {
    const r = await admitted();
    const plain = await w.stocked("Plainol 500", { qty: 20 });
    const narcotic = await w.stocked("Morphix 10", { narcotic: true, qty: 20 });
    expect(await codeOf(charge(r.admissionId, [{ medicineId: plain.medicineId, units: 2 }, { medicineId: narcotic.medicineId, units: 1 }]))).toBe("controlled_at_counter");
    const bare = await addBatch(plain.itemId, { mrpPaise: null, qty: 10, expiry: "2031-06-30" });
    expect(await codeOf(charge(r.admissionId, [{ medicineId: plain.medicineId, units: 2 }, { medicineId: plain.medicineId, units: 2, batchId: bare }]))).toBe("price_missing");
    expect(await codeOf(charge(r.admissionId, [{ medicineId: plain.medicineId, units: 31 }]))).toBe("stock_short");
    expect(await lines(r.admissionId)).toEqual([]);
    expect(await db.select().from(ipdChargeExceptions).where(eq(ipdChargeExceptions.admissionId, r.admissionId))).toEqual([]);
    expect([await onHand(plain.batchId), await onHand(bare), await onHand(narcotic.batchId)]).toEqual([20, 10, 20]);
  });

  it("only a pharmacist who issues to the ward may charge to IP", async () => {
    const r = await admitted();
    const med = await w.stocked("Guardol 500");
    expect(await codeOf(counterCharge(db, w.nurse, { idempotencyKey: key(), admissionId: r.admissionId, lines: [{ medicineId: med.medicineId, units: 1 }] }, { now: SALE_AT })))
      .toBe("ipd_forbidden");
    expect(await codeOf(lookupCounterAdmission(db, w.nurse, r.admissionNo, { now: SALE_AT }))).toBe("ipd_forbidden");
  });

  it("a return reverses the charge as a ward return does: the kept units at the sale's price, stock back to the batch it left", async () => {
    const r = await admitted();
    const med = await w.stocked("Backmox 500", { qty: 30 });
    const sale = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 10 }]);
    // The shelf price moves after the sale: the return must not read it.
    await db.update(stockBatches).set({ mrpPaise: 9000 }).where(eq(stockBatches.id, med.batchId));
    const back = await giveBack(sale.saleId, med.itemId, 4, ist("2026-03-11T15:00:00"));
    expect(back).toEqual({ returnId: back.returnId, units: 4, creditedUnits: 4 });
    expect((await lines(r.admissionId)).map((l) => [l.source, l.qty, l.netPaise, l.drugSeq])).toEqual([
      ["ipd.pharmacy", 10, 1000, 0], ["ipd.reversal", 10, -1000, 0], ["ipd.pharmacy", 6, 600, 1],
    ]);
    expect(await onHand(med.batchId)).toBe(24);
    expect(await codeOf(giveBack(sale.saleId, med.itemId, 7, ist("2026-03-11T16:00:00")))).toBe("return_exceeds_issue");
    expect(await codeOf(giveBack(sale.saleId, newId(), 1, ist("2026-03-11T16:00:00")))).toBe("not_on_sale");
    expect(await codeOf(giveBack(newId(), med.itemId, 1, ist("2026-03-11T16:00:00")))).toBe("counter_sale_not_found");
    await giveBack(sale.saleId, med.itemId, 6, ist("2026-03-11T16:30:00"));
    expect(await live(r.admissionId)).toEqual([]);
    expect(await onHand(med.batchId)).toBe(30);
    const listed = await readCounterSales(db, w.pharmacist, r.admissionId);
    expect(listed.sales.map((s) => [s.saleId, s.lines.map((l) => [l.itemId, l.units, l.returned])])).toEqual([[sale.saleId, [[med.itemId, 10, 10]]]]);
    expect((await db.select().from(events).where(eq(events.name, "ipd.med.counter_returned"))).map((e) => e.actorId)).toEqual([w.pharmacist.id, w.pharmacist.id]);
  });

  it("a return after the bill is a bill-desk decision; after the void billing credits exactly the units that came back", async () => {
    const r = await admitted();
    const med = await w.stocked("Latemox 500", { qty: 30 });
    const sale = await charge(r.admissionId, [{ medicineId: med.medicineId, units: 10 }]);
    const [line] = await live(r.admissionId);
    await settleBillOver(r.admissionId, [line!.id], ist("2026-03-11T12:00:00"));
    const back = await giveBack(sale.saleId, med.itemId, 3, ist("2026-03-11T13:00:00"));
    expect(back.creditedUnits).toBe(0);
    const open = (await db.select().from(ipdChargeExceptions).where(and(eq(ipdChargeExceptions.admissionId, r.admissionId), isNull(ipdChargeExceptions.resolvedAt))));
    expect(open.map((x) => [x.reason, x.key.split(":")[3]])).toEqual([["return_after_bill", line!.id]]);
    await db.update(ipdFinalBills).set({ voidedAt: ist("2026-03-11T14:00:00"), voidedBy: w.billDesk.id, voidReason: "Fixture void", voidApprovalId: "fixture" } as never)
      .where(eq(ipdFinalBills.admissionId, r.admissionId));
    await reverseChargeLine(db, w.billDesk, { chargeLineId: line!.id, reason: "Returned after the bill" }, { now: ist("2026-03-11T14:05:00") });
    expect((await live(r.admissionId)).map((l) => [l.qty, l.netPaise, l.drugSeq])).toEqual([[7, 700, 1]]);
  });
});
