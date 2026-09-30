import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, grns, stockBatches } from "../../kernel/db/schema";
import { normalizeDrugName } from "../formulary";
import { registerItem } from "./items";
import { createStore } from "./stores";
import { captureGrn, getGrn, postGrn, runGateQc } from "./grn";
import { activateVendor, addVendorDocument, registerVendor } from "./vendors";
import { loadMaterialsSettings, updateMaterialsSettings } from "./settings";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER RULING 2026-09-30 (pharmacy money, point 3) — *"the system should recommend to enforce two
 * different people later via settings screen but currently admin login can do both."* The two-person
 * GRN rule is a SETTING, off by default: off, the capturer QCs and posts (today); on, `runGateQc` and
 * `postGrn` refuse the capturer with `grn_same_person`. Every change is `store_settings.changed`.
 */
const CAPTURER: Actor = { type: "user", id: "01HGRNCAPTURER000000000001" };
const CHECKER: Actor = { type: "user", id: "01HGRNCHECKER0000000000001" };
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000002" };
const T0 = new Date("2026-09-30T06:00:00Z");

describe("the two-person GRN setting (owner ruling 2026-09-30)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function captured(challanNo: string): Promise<string> {
    const medicineId = newId();
    await db.insert(formularyMedicines).values({
      id: medicineId, brandName: `Brand ${medicineId}`, nameNormalized: normalizeDrugName(`Brand ${medicineId}`), form: "tablet",
      createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    const code = `IT${medicineId.slice(-6)}`;
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: `Item ${code}`, class: "drug", formularyMedicineId: medicineId,
      baseUom: "tablet", batchTracked: true, shelfLifeDays: 1095, uoms: [{ uom: "strip", toBaseMultiplier: 10 }],
    }));
    const { resourceId: storeId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: `S${medicineId.slice(-6)}`, name: "Store" }));
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, HEAD, { code: `V${medicineId.slice(-6)}`, legalName: "Acme Pharma Pvt Ltd" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, HEAD, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, HEAD, vendorId, T0));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, CAPTURER, {
      vendorId, source: "challan", storeResourceId: storeId, challanNo, challanDate: "2026-09-30", now: T0,
      lines: [{
        itemId, uom: "strip", qtyInUom: 3, batchNo: "B-1", mfgDate: "2026-01-01", expiryDate: "2028-06-30",
        mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 700,
      }],
    }));
    return grnId;
  }

  const setTo = (on: boolean, actor: Actor = HEAD): Promise<unknown> =>
    withTx(db, (tx) => updateMaterialsSettings(tx, actor, { grnQcNeedsSecondPerson: on }, T0));

  it("OFF by default: no row reads as off, and the capturer QCs and posts their own delivery (today's behaviour)", async () => {
    expect(await loadMaterialsSettings(db)).toEqual({ grnQcNeedsSecondPerson: false, updatedBy: null, updatedAt: null });
    const grnId = await captured("CH/OFF/1");
    await withTx(db, (tx) => runGateQc(tx, CAPTURER, grnId));
    const posted = await withTx(db, (tx) => postGrn(tx, CAPTURER, grnId, T0));
    expect(posted.status).toBe("posted");
    expect(await getGrn(db, grnId)).toMatchObject({ status: "posted", capturedBy: CAPTURER.id, qcBy: CAPTURER.id });
  });

  it("ON: the capturer's QC is refused with grn_same_person and writes nothing; a second person's QC and post go through", async () => {
    await setTo(true);
    const grnId = await captured("CH/ON/1");

    await expect(withTx(db, (tx) => runGateQc(tx, CAPTURER, grnId))).rejects.toMatchObject({
      code: "grn_same_person", detail: { act: "qc", capturedBy: CAPTURER.id },
    });
    expect(await getGrn(db, grnId)).toMatchObject({ status: "gate_qc", qcBy: null });

    await withTx(db, (tx) => runGateQc(tx, CHECKER, grnId));
    await expect(withTx(db, (tx) => postGrn(tx, CAPTURER, grnId, T0))).rejects.toMatchObject({
      code: "grn_same_person", detail: { act: "post" },
    });
    expect(await db.select().from(stockBatches)).toHaveLength(0);

    await withTx(db, (tx) => postGrn(tx, CHECKER, grnId, T0));
    expect(await getGrn(db, grnId)).toMatchObject({ status: "posted", capturedBy: CAPTURER.id, qcBy: CHECKER.id });
  });

  it("turned ON after the capturer already QC'd their own delivery: the post still needs somebody else", async () => {
    const grnId = await captured("CH/LATE/1");
    await withTx(db, (tx) => runGateQc(tx, CAPTURER, grnId));
    await setTo(true);
    await expect(withTx(db, (tx) => postGrn(tx, CAPTURER, grnId, T0))).rejects.toMatchObject({ code: "grn_same_person" });
    await withTx(db, (tx) => postGrn(tx, CHECKER, grnId, T0));
    const [row] = await db.select().from(grns).where(eq(grns.id, grnId));
    expect(row!.status).toBe("posted");
  });

  it("every change is audited as store_settings.changed with the old and new value and the person; a save that changes nothing is not", async () => {
    await setTo(true);
    await setTo(true); // no-op
    await setTo(false, CHECKER);

    const changed = await db.select().from(events).where(eq(events.name, "store_settings.changed")).orderBy(events.seq);
    expect(changed.map((e) => ({ payload: e.payload, actorId: e.actorId, module: e.module }))).toEqual([
      { payload: { setting: "grn_qc_needs_second_person", from: false, to: true }, actorId: HEAD.id, module: "materials" },
      { payload: { setting: "grn_qc_needs_second_person", from: true, to: false }, actorId: CHECKER.id, module: "materials" },
    ]);
    expect(await loadMaterialsSettings(db)).toMatchObject({ grnQcNeedsSecondPerson: false, updatedBy: CHECKER.id });

    // Only a person changes it, and only with the one field it has.
    await expect(withTx(db, (tx) => updateMaterialsSettings(tx, { type: "system", id: "job" }, { grnQcNeedsSecondPerson: true }, T0)))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(withTx(db, (tx) => updateMaterialsSettings(tx, HEAD, { grnQcNeedsSecondPerson: true, extra: 1 }, T0))).rejects.toThrow();
    expect(await db.select().from(events).where(eq(events.name, "store_settings.changed"))).toHaveLength(2);
  });
});
