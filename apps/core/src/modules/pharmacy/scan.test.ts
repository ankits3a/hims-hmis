import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events } from "../../kernel/db/schema";
import { addBarcode, availableQty, createStore } from "../materials";
import { claimDispense, findAtCounter } from "./claim";
import { parseGs1 } from "./gs1";
import { pickDispense } from "./pick";
import { checkPickScan } from "./scan";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P13 — THE PACK IS SCANNED AT THE PICK ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p13-scan-to-pick.md`. Doc 16 §534's
 * "label/scanner support" and C2. A scan that names another item is the wrong drug in the aide's
 * hand, and it is refused before anything is reserved. A GS1 code also carries the batch and
 * expiry, and the batch it names is the one picked. Scanning is optional: many Indian packs carry
 * no barcode at all.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const CROCIN_EAN = "8901234567897";
const CALPOL_EAN = "8909876543217";
/** The ASCII group separator a scanner sends between a variable GS1 field and the next one. */
const GS = String.fromCharCode(29);

describe("the GS1 element string (P13)", () => {
  it("reads the bracketed and the raw forms, fixed and variable fields, and the day-00 expiry", () => {
    expect(parseGs1("(01)08901234567897(17)270630(10)CR-2")).toEqual({ gtin: "08901234567897", expiry: "2027-06-30", batch: "CR-2" });
    // Raw, with the symbology prefix a scanner may send, and a variable batch ended by GS before a fixed field.
    expect(parseGs1(`]d2010890123456789710CR-2${GS}17271200`)).toEqual({ gtin: "08901234567897", expiry: "2027-12-31", batch: "CR-2" });
    expect(parseGs1("01089012345678971727063010CR-1")).toEqual({ gtin: "08901234567897", expiry: "2027-06-30", batch: "CR-1" });
    // A plain EAN-13 and a short GTIN are not GS1 element strings; an impossible month is no expiry.
    expect(parseGs1(CROCIN_EAN)).toBeNull();
    expect(parseGs1("(01)123(10)X")).toBeNull();
    expect(parseGs1("(01)08901234567897(17)271301")).toEqual({ gtin: "08901234567897", expiry: null, batch: null });
  });
});

describe("scanning the pack at the pick (pharmacy P13)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30, expiryDate: "2027-06-30", at: MON });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-2", qtyBase: 30, expiryDate: "2027-12-31", at: MON });
    await withTx(db, (tx) => addBarcode(tx, HEAD, fx.item.crocin, { code: CROCIN_EAN, packUom: "strip" }));
    await withTx(db, (tx) => addBarcode(tx, HEAD, fx.item.calpol, { code: CALPOL_EAN, packUom: "strip" }));
  });
  afterEach(() => { fx.unregister(); });

  async function verified(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    return r.dispense.id;
  }
  const pickedEvent = async () => (await db.select().from(events).where(eq(events.name, "dispense.picked")))
    .map((e) => (e.payload as { lines: unknown[] }).lines);

  it("picks FEFO's batch on a plain pack scan, and the batch a GS1 scan names", async () => {
    const plain = await verified();
    expect(await checkPickScan(db, plain, 0, CROCIN_EAN)).toEqual({ itemCode: "CROC500", batchNo: null, expiryDate: null });
    const a = await pickDispense(db, fx.pharmacist.actor, fx.decls, plain, { lines: [{ lineIdx: 0, scan: CROCIN_EAN }] }, MON2);
    expect(a.lines[0]).toMatchObject({ batchId: expect.any(String), fefoOverride: false });

    const gs1 = await verified();
    const code = "(01)08901234567897(17)271231(10)CR-2";
    expect(await checkPickScan(db, gs1, 0, code)).toEqual({ itemCode: "CROC500", batchNo: "CR-2", expiryDate: "2027-12-31" });
    const b = await pickDispense(db, fx.pharmacist.actor, fx.decls, gs1, { lines: [{ lineIdx: 0, scan: code }] }, MON2);
    expect(b.lines[0]).toMatchObject({ fefoOverride: true });
    expect(b.lines[0]!.batchId).not.toBe(a.lines[0]!.batchId);

    expect(await pickedEvent()).toEqual([
      [{ lineIdx: 0, batchId: a.lines[0]!.batchId, qtyBase: 10, fefoOverride: false, scanned: true }],
      [{ lineIdx: 0, batchId: b.lines[0]!.batchId, qtyBase: 10, fefoOverride: true, scanned: true }],
    ]);
  });

  it("records a pick with no scan as unscanned", async () => {
    const id = await verified();
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    expect(await pickedEvent()).toEqual([[expect.objectContaining({ scanned: false })]]);
  });

  it("refuses the wrong pack, a code nobody registered, a batch the counter does not hold, and a pack whose expiry disagrees with the books, reserving nothing", async () => {
    const id = await verified();
    const refuse = async (scan: string, code: string): Promise<void> => {
      await expect(checkPickScan(db, id, 0, scan)).rejects.toMatchObject({ code });
      await expect(pickDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, scan }] }, MON2)).rejects.toMatchObject({ code });
    };
    await refuse(CALPOL_EAN, "scan_wrong_item");
    await refuse("0000000000000", "scan_unknown");
    await refuse("(01)08901234567897(17)271231(10)ZZ-9", "scan_batch_unknown");
    // A batch that exists, but on another store's shelf, is not in this counter's hand either.
    const { resourceId: main } = await withTx(db, (tx) => createStore(tx, HEAD, { code: "MAIN-STORE", name: "Main store" }));
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-9", qtyBase: 30, expiryDate: "2028-03-31", at: MON, resourceId: main });
    await refuse("(01)08901234567897(17)280331(10)CR-9", "scan_batch_unknown");
    await refuse("(01)08901234567897(17)280131(10)CR-2", "scan_batch_mismatch");
    await expect(checkPickScan(db, id, 5, CROCIN_EAN)).rejects.toMatchObject({ code: "unknown_line" });

    expect(await availableQty(db, fx.storeId, fx.item.crocin, MON2)).toBe(60);
  });
});
