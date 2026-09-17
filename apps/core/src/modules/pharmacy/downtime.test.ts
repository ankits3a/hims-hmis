import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, addAllergy, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { withTx } from "../../kernel/db/client";
import { events, operatingModeChanges, pharmacyRegH1, pharmacyRetailSales, stockLedger } from "../../kernel/db/schema";
import { hmacSign } from "../../kernel/crypto";
import { generateDowntimeKit, getKitPrintPayload } from "../../kernel/ops/downtime-kit";
import { createStore } from "../materials";
import { RETAIL_PHARMACY_STORE_CODE, RETAIL_REF_TYPE, RETAIL_RETURN_REF_TYPE } from "./config";
import { pharmacyLeakage } from "./leakage";
import {
  enterPaperDispense, inspectSheet, listPaperDispenses, listRetailSales, pharmacyStaff, previewPaperDispense,
} from "./retail";
import { acceptRetailReturn } from "./retail-returns";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { PaperDispenseInput } from "./retail";

/**
 * ═══ PHARMACY P20 — PAPER DISPENSES ENTERED AFTER AN OUTAGE ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p20-paper-dispenses.md`.
 *
 * The timeline every test shares: the hospital runs normally until MON (09:30 IST), is declared
 * down at MON, and recovers at MON + 2 h. The kit was printed half an hour before the outage. The
 * pharmacist enters the sheets at MON + 3 h.
 */
class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> { return this.files.get(key) ?? Buffer.alloc(0); }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}

const KEY = Buffer.alloc(32, 0x3d);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DUTY: Actor = { type: "user", id: "01HDUTYMANAGER000000000009" };
const DURING = new Date(MON.getTime() + 30 * MIN);
const ENTRY = new Date(MON.getTime() + 3 * HOUR);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("paper dispenses entered after an outage (P20)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let docs: FakeStore;
  let sheets: string[];
  let consultationSheet: string;
  let kitId: string;
  let batch: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    docs = new FakeStore();
    await openSessionFor(db, { id: fx.incharge.id }, 0);
    const mode = (from: string, to: string, at: Date) => ({
      id: newId(), fromMode: from, toMode: to, note: to === "downtime" ? "UPS failure" : null, reportId: null, actorId: DUTY.id, at,
    });
    await db.insert(operatingModeChanges).values([
      mode("commissioning", "normal", new Date(MON.getTime() - 24 * HOUR)),
      mode("normal", "downtime", MON),
      mode("downtime", "normal", new Date(MON.getTime() + 2 * HOUR)),
    ]);
    const kit = await withTx(db, (tx) => generateDowntimeKit(tx, DUTY, {
      note: null, desks: [{ desk: "pharmacy-counter", counts: { receipt: 3, consultation: 1 } }],
    }, new Date(MON.getTime() - 30 * MIN)));
    kitId = kit.id;
    const payload = await getKitPrintPayload(db, KEY, kit.id);
    sheets = payload.ranges.find((r) => r.formKind === "receipt")!.forms.map((f) => f.qr);
    consultationSheet = payload.ranges.find((r) => r.formKind === "consultation")!.forms[0]!.qr;
    batch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-7", qtyBase: 50, at: new Date(MON.getTime() - 24 * HOUR) });
  });
  afterEach(() => { fx.unregister(); });

  const paper = (over: Partial<PaperDispenseInput> = {}): PaperDispenseInput => ({
    sheetQr: sheets[0]!, storeCode: "PHARM-OPD", occurredAt: DURING, dispensedBy: fx.pharmacist.id,
    customer: { existingId: fx.patient.id }, lines: [{ medicineId: fx.med.crocin, qtyBase: 10, batchId: batch }],
    tenders: [{ mode: "cash", amountPaise: 12000 }], ...over,
  });
  const enter = (over: Partial<PaperDispenseInput> = {}, now = ENTRY, actor: Actor = fx.incharge.actor) =>
    enterPaperDispense(db, docs, KEY, actor, paper(over), undefined, now);

  it("records the sheet as it happened: the time on it, who handed it over, the batch it names, and the invoice issued now", async () => {
    const preview = await previewPaperDispense(db, fx.incharge.actor, { storeCode: "PHARM-OPD", occurredAt: DURING, lines: paper().lines }, ENTRY);
    expect(preview.lines.map((l) => [l.batchNo, l.qtyBase])).toEqual([["CR-7", 10]]);
    expect(preview.totals.netPayablePaise).toBe(12000);

    expect(await inspectSheet(db, fx.incharge.actor, KEY, sheets[0]!)).toEqual({
      valid: true, desk: "pharmacy-counter", serial: 1, kitGeneratedAt: new Date(MON.getTime() - 30 * MIN).toISOString(), enteredSaleId: null,
    });
    const sale = await enter();
    expect(sale).toMatchObject({
      channel: "downtime", storeCode: "PHARM-OPD", soldAt: DURING.toISOString(), soldBy: fx.pharmacist.id, enteredBy: fx.incharge.id,
      sheet: { kitId, serial: 1, desk: "pharmacy-counter" }, netPaise: 12000, lines: [{ batchId: batch, qtyBase: 10 }],
    });
    const [ledger] = await db.select().from(stockLedger).where(eq(stockLedger.refType, RETAIL_REF_TYPE));
    expect(ledger).toMatchObject({ reason: "consume", qtyDelta: -10, resourceId: fx.storeId, occurredAt: DURING, patientId: fx.patient.id });
    const [row] = await db.select().from(pharmacyRetailSales);
    expect(row).toMatchObject({ licenceId: null, createdAt: expect.any(Date) });
    const [sold] = await db.select().from(events).where(eq(events.name, "retail.sold"));
    expect(sold!.payload).toMatchObject({ channel: "downtime", soldAt: DURING.toISOString(), soldBy: fx.pharmacist.id, sheet: { serial: 1 }, licenceId: null });

    // Once per sheet, and the scan says so before anything is typed.
    expect((await inspectSheet(db, fx.incharge.actor, KEY, sheets[0]!)).enteredSaleId).toBe(sale.id);
    await expect(enter()).rejects.toMatchObject({ code: "sheet_already_entered" });
    // A paper dispense is not a walk-in sale on the till's day list, and is on its own.
    expect(await listRetailSales(db, fx.incharge.actor, "2026-08-17")).toEqual([]);
    expect((await listPaperDispenses(db, fx.incharge.actor)).map((r) => [r.id, r.channel, r.sheet])).toEqual([
      [sale.id, "downtime", { desk: "pharmacy-counter", serial: 1 }],
    ]);
    expect((await pharmacyStaff(db, fx.incharge.actor, ENTRY)).map((p) => [p.username, p.registered])).toEqual([
      ["aide.ravi", false], ["ph.incharge", false], ["ph.mehta", true],
    ]);
  });

  it("accepts only a kit's receipt sheet, dated inside a declared outage, recent, and not in the future", async () => {
    const forged = `dtk1.${kitId}.receipt.99`;
    for (const sheetQr of [`${forged}.${hmacSign(KEY, forged)}`, consultationSheet, "not a sheet", sheets[0]!.slice(0, -2)]) {
      await expect(enter({ sheetQr })).rejects.toMatchObject({ code: "sheet_invalid" });
    }
    expect((await inspectSheet(db, fx.incharge.actor, KEY, consultationSheet)).valid).toBe(false);
    // Before the kit was printed, and after the entry itself.
    await expect(enter({ occurredAt: new Date(MON.getTime() - HOUR) })).rejects.toMatchObject({ code: "invalid_dispense_time" });
    await expect(enter({ occurredAt: new Date(ENTRY.getTime() + MIN) })).rejects.toMatchObject({ code: "invalid_dispense_time" });
    // After recovery, the counter was running: no paper then.
    await expect(enter({ occurredAt: new Date(MON.getTime() + 150 * MIN) })).rejects.toMatchObject({ code: "not_in_downtime", detail: { mode: "normal" } });
    await expect(enter({}, new Date(DURING.getTime() + 8 * 24 * HOUR))).rejects.toMatchObject({ code: "backfill_window_closed" });
    await expect(enter({ lines: [{ medicineId: fx.med.crocin, qtyBase: 10 }] })).rejects.toMatchObject({ code: "batch_required" });
    await expect(enter({ dispensedBy: fx.clerk.id })).rejects.toMatchObject({ code: "unknown_pharmacist" });
    await expect(enter({}, ENTRY, fx.aide.actor)).rejects.toMatchObject({ code: "permission_denied" });
    // A walk-in counter's sheet needs the retail licence on that day.
    await withTx(db, (tx) => createStore(tx, { type: "user", id: "01HMATERIALSHEAD00000000001" }, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await expect(enter({ storeCode: RETAIL_PHARMACY_STORE_CODE })).rejects.toMatchObject({ code: "retail_licence_missing" });
    expect(await db.select().from(pharmacyRetailSales)).toEqual([]);
    expect(await db.select().from(stockLedger).where(eq(stockLedger.refType, RETAIL_REF_TYPE))).toEqual([]);
  });

  it("judges expiry, the pharmacist's registration and the prescription on the day on the sheet, and writes the register with that date", async () => {
    // Expired the day before the sheet: the pharmacist wrote the wrong batch, or dispensed what they must not.
    const stale = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OLD", qtyBase: 20, expiryDate: "2026-08-16", at: new Date(MON.getTime() - 24 * HOUR) });
    await expect(enter({ lines: [{ medicineId: fx.med.crocin, qtyBase: 10, batchId: stale }] })).rejects.toMatchObject({ code: "batch_expired" });
    // Expiring ON the sheet's day was still in date then, though it has lapsed by the time it is entered.
    const lastDay = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "LAST", qtyBase: 20, expiryDate: "2026-08-17", at: new Date(MON.getTime() - 24 * HOUR) });
    const nextDay = new Date(DURING.getTime() + 24 * HOUR);
    expect((await enter({ sheetQr: sheets[1]!, lines: [{ medicineId: fx.med.crocin, qtyBase: 10, batchId: lastDay }] }, nextDay)).lines[0]?.batchId).toBe(lastDay);

    const azee = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-3", qtyBase: 30, at: new Date(MON.getTime() - 24 * HOUR) });
    const h1 = { sheetQr: sheets[2]!, lines: [{ medicineId: fx.med.azithro, qtyBase: 3, batchId: azee }] };
    const rx = { prescriberName: "Dr S. Sen", prescriberRegNo: "WBMC-7788", prescriberAddress: "OPD, this hospital", rxDate: "2026-08-17", photo: { mimeType: "image/jpeg", bytes: JPEG } };
    await expect(enter(h1)).rejects.toMatchObject({ code: "prescription_required" });
    await expect(enter({ ...h1, prescription: { ...rx, rxDate: "2026-08-18" } }, nextDay)).rejects.toMatchObject({ code: "invalid_prescription" });
    // Named as handing it over, holds `pharmacy`, and has no registration on file.
    await expect(enter({ ...h1, prescription: rx, dispensedBy: fx.incharge.id })).rejects.toMatchObject({ code: "pharmacist_not_registered" });

    // The customer is recorded allergic: the medicine is already with them, so the hit is recorded, not refused.
    await addAllergy(db, fx.patient.id, "Azithromycin");
    const sale = await enter({ ...h1, prescription: rx });
    expect(sale).toMatchObject({ scheduled: true, pharmacistRegNo: "MSPC-123456", soldBy: fx.pharmacist.id });
    const [reg] = await db.select().from(pharmacyRegH1);
    expect(reg).toMatchObject({ dispensedAt: DURING, recordedBy: fx.incharge.id, pharmacistRegNo: "MSPC-123456", prescriberName: "Dr S. Sen", batchNo: "AZ-3" });
    const sold = await db.select().from(events).where(eq(events.name, "retail.sold"));
    expect(sold.map((e) => (e.payload as { checkHits: unknown }).checkHits)).toEqual([
      { allergies: 0, severeInteractions: 0 }, { allergies: 1, severeInteractions: 0 },
    ]);
  });

  it("is a sold line in the OPD counter's leakage triangle, and its sealed strip comes back into the OPD store (P19b)", async () => {
    const sale = await enter();
    // Before P19b the report listed this consume row as stock that left with no dispense behind it.
    const report = await pharmacyLeakage(db, "2026-08-17");
    expect(report.otherConsumption).toEqual([]);
    expect(report.dispensed).toEqual({ lines: 1, units: 10 });
    expect(report.mismatches).toEqual([]);

    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    const back = await acceptRetailReturn(db, fx.pharmacist.actor, sale.id, {
      lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "the patient was admitted", reasonClass: "genuine",
    }, undefined, new Date(ENTRY.getTime() + HOUR));
    expect(back.sale.lines.map((l) => l.returnedQtyBase)).toEqual([10]);
    const [row] = await db.select().from(stockLedger).where(eq(stockLedger.refType, RETAIL_RETURN_REF_TYPE));
    expect(row).toMatchObject({ reason: "return", resourceId: fx.storeId, batchId: batch, qtyDelta: 10 });
    const [returned] = await db.select().from(events).where(eq(events.name, "retail.line_returned"));
    expect(returned!.payload).toMatchObject({ saleId: sale.id, channel: "downtime", storeResourceId: fx.storeId });
    // Restocked and credited: the day still balances.
    expect((await pharmacyLeakage(db, "2026-08-17")).mismatches).toEqual([]);
  });
});
