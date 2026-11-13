import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { events, pharmacyRegH1 } from "../../kernel/db/schema";
import { balances } from "../materials";
import { addDispenseLine } from "./add-line";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { NO_PRESCRIPTION_PRESCRIBER } from "./config";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

/**
 * Spec #1055, ruling 0094 — a medicine added by hand, in each state it may arrive in (`add-line.ts`). The acceptance
 * check is `acceptance/add-medicine-1055.test.ts`; these pin the rest of the rules the spec's decisions name.
 */
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };

describe("add a medicine by hand (spec #1055)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let A: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    A = fx.pharmacist.actor;
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000 });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30, expiryDate: "2027-12-31", mrpPaise: 9000 });
  });
  afterEach(() => { fx.unregister(); });

  async function ticket(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { at: MON });
    const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, A, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);
    return found.dispense.id;
  }
  const reserved = async (itemId: string): Promise<number> => (await balances(db, { resourceId: fx.storeId, itemId })).reduce((n, b) => n + b.qtyReserved, 0);

  it("on a collected ticket the line is held at once (FEFO), the ticket stays picked, the bill re-totals, and the line has no order item", async () => {
    const id = await ticket();
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    const before = await previewDispenseBill(db, A, id, MON2);
    const after = await addDispenseLine(db, docs, A, fx.decls, id, { itemId: fx.item.azithro, reason: "not_prescribed", qtyBase: 3 }, MON2);
    expect(after.status).toBe("picked");
    const added = after.lines.find((l) => l.added !== null)!;
    expect(added).toMatchObject({ scheduleFlag: "H1", qtyBase: 3, orderItemId: null, pickedBatch: { batchNo: "AZ-1" } });
    expect(await reserved(fx.item.azithro)).toBe(3);
    expect(after.scheduled).toBe(true);
    const repriced = await previewDispenseBill(db, A, id, MON2);
    expect(repriced.totals.grossPaise).toBeGreaterThan(before.totals.grossPaise);
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.line_added"));
    expect(ev!.payload).toMatchObject({ dispenseId: id, reason: "not_prescribed", dispenseStatus: "picked", reserved: true, addedByName: "ph.mehta" });
  });

  it("an H1 medicine added as not prescribed is written to the H1 register with 'no prescription — added at the counter' in place of the prescriber", async () => {
    const id = await ticket();
    await addDispenseLine(db, docs, A, fx.decls, id, { itemId: fx.item.azithro, reason: "not_prescribed", qtyBase: 3 }, MON2);
    const v = await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 3 }] }, MON2);
    expect(v.lines.find((l) => l.lineIdx === 1)!.orderItemId).not.toBeNull(); // added before the check: the check's order takes it
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    const p = await previewDispenseBill(db, A, id, MON2, { tender: "cash" });
    await billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: p.byTender.cash.netPayablePaise }] }, MON2);
    await handOverDispense(db, A, fx.decls, id, { identity: { via: "collected_by", who: "self" } }, MON3);
    const rows = await db.select().from(pharmacyRegH1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prescriberName: NO_PRESCRIPTION_PRESCRIBER, prescriberRegNo: null, qtyBase: 3 });
  });

  it("an H1 medicine written on paper needs the prescriber's name and registration number; the register then names them", async () => {
    const id = await ticket();
    const photo = { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) };
    await expect(addDispenseLine(db, docs, A, fx.decls, id, { itemId: fx.item.azithro, reason: "paper", qtyBase: 3, photo, prescriber: { name: "Dr Rao" } }, MON2))
      .rejects.toMatchObject({ code: "invalid_prescription" });
    const d = await addDispenseLine(db, docs, A, fx.decls, id, { itemId: fx.item.azithro, reason: "paper", qtyBase: 3, photo, prescriber: { name: "Dr Rao", registrationNo: "MMC-4411" } }, MON2);
    expect(d.lines.find((l) => l.added !== null)!.added).toMatchObject({ reason: "paper", prescriberName: "Dr Rao", prescriberRegNo: "MMC-4411", documentId: expect.any(String) });
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 3 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    const p = await previewDispenseBill(db, A, id, MON2, { tender: "cash" });
    await billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: p.byTender.cash.netPayablePaise }] }, MON2);
    await handOverDispense(db, A, fx.decls, id, { identity: { via: "collected_by", who: "self" } }, MON3);
    expect(await db.select().from(pharmacyRegH1)).toEqual([expect.objectContaining({ prescriberName: "Dr Rao", prescriberRegNo: "MMC-4411" })]);
  });

  it("the allergy book refuses an added line as it refuses a prescribed one, and nothing is written", async () => {
    await addAllergy(db, fx.patient.id, "Azithromycin");
    const id = await ticket();
    await expect(addDispenseLine(db, docs, A, fx.decls, id, { itemId: fx.item.azithro, reason: "not_prescribed", qtyBase: 3 }, MON2))
      .rejects.toMatchObject({ code: "allergy_block" });
    const [row] = await db.select().from(events).where(eq(events.name, "dispense.line_added"));
    expect(row).toBeUndefined();
  });

  it("never after the bill", async () => {
    const id = await ticket();
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    const p = await previewDispenseBill(db, A, id, MON2, { tender: "cash" });
    await billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: p.byTender.cash.netPayablePaise }] }, MON2);
    await expect(addDispenseLine(db, docs, A, fx.decls, id, { itemId: fx.item.crocin, reason: "not_prescribed", qtyBase: 5 }, MON2))
      .rejects.toMatchObject({ code: "dispense_not_in_state" });
  });
});
