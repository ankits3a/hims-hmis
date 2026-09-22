import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { invoiceLines, items } from "../../kernel/db/schema";
import { addMedicine, addSalt } from "../formulary";
import { registerItem, updateItem } from "../materials";
import { serviceCategoriesByIds } from "../tariff";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { NIL_RATED_DRUGS, applyGstSlabPlan, gstSlabPlan, suggestGstSlab } from "./gst-slab";
import { pickDispense } from "./pick";
import { getSaleItem, registerSaleItem } from "./sale-items";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P16 — EACH DRUG'S GST SLAB, AND THE BILL THAT FOLLOWS IT ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p16-gst-slabs.md`. Notification
 * 9/2025-CT(Rate), from 22 September 2025: medicaments 5%, the 36 listed drugs nil.
 */
describe("the GST slab rule (P16)", () => {
  it("is nil only when every ingredient is on the notified list, and 5% for any other medicine", () => {
    expect(NIL_RATED_DRUGS).toHaveLength(36);
    expect(suggestGstSlab([{ name: "Daratumumab" }])?.rateBps).toBe(0);
    // List 4, and the spellings a release uses.
    expect(suggestGstSlab([{ name: "AGALSIDASE BETA" }])?.rateBps).toBe(0);
    expect(suggestGstSlab([{ name: "Velaglucerase alpha" }])?.rateBps).toBe(0);
    expect(suggestGstSlab([{ name: "Idursulfatase" }])?.rateBps).toBe(0);
    expect(suggestGstSlab([{ name: "eptacog alfa" }])?.rateBps).toBe(0);
    expect(suggestGstSlab([{ name: "Rituximab", aliases: ["Evolocumab"] }])?.rateBps).toBe(0);
    // Everything else, and a combination with anything else.
    expect(suggestGstSlab([{ name: "Paracetamol" }])).toEqual({ rateBps: 500, basis: expect.stringContaining("5%") });
    expect(suggestGstSlab([{ name: "Daratumumab" }, { name: "Dexamethasone" }])?.rateBps).toBe(500);
    // Nothing to judge.
    expect(suggestGstSlab([])).toBeNull();
    expect(suggestGstSlab([{ name: "Daratumumab" }])?.basis).toContain("Notification 9/2025");
  });
});

describe("setting the slabs, and the bill that follows them (P16)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
  let darz: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    // A nil-rated biologic with no slab yet, registered for sale (so its service says exempt).
    darz = await withTx(db, async (tx) => {
      const dara = await addSalt(tx, fx.pharmacist.actor, { name: "Daratumumab", drugClass: "monoclonal_antibody" });
      const med = await addMedicine(tx, fx.pharmacist.actor, { brandName: "Darzalex 400", form: "injection", routeClass: "systemic", strengthLabel: "400 mg", scheduleFlag: "H", salts: [{ saltId: dara.saltId, strength: "400 mg" }] });
      const { itemId } = await registerItem(tx, HEAD, { code: "DARZ400", name: "Darzalex 400 mg vial", class: "drug", baseUom: "vial", batchTracked: true, formularyMedicineId: med.medicineId, uoms: [] });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return itemId;
    });
  });
  afterEach(() => { fx.unregister(); });

  const category = async (itemId: string): Promise<string | undefined> => {
    const sale = await getSaleItem(db, itemId);
    return (await serviceCategoriesByIds(db, [sale!.serviceId])).get(sale!.serviceId);
  };

  it("fills a blank slab, reports a slab that disagrees, and brings a stale sale category back to its slab", async () => {
    // Crocin's slab is corrected straight on the item (the materials PATCH), leaving its service at 12%.
    await withTx(db, (tx) => updateItem(tx, HEAD, fx.item.crocin, { gstRateBps: 500 }));
    expect(await category(fx.item.crocin)).toBe("pharmacy");

    const plan = await gstSlabPlan(db);
    expect(plan.map((p) => [p.code, p.current, p.suggested, p.verdict, p.categoryStale])).toEqual([
      ["AZEE500", 500, 500, "ok", false],
      ["CALP500", 1200, 500, "differs", false],
      ["CROC500", 500, 500, "ok", true],
      ["DARZ400", null, 0, "set", false],
    ]);

    const applied = await applyGstSlabPlan(db, HEAD, plan);
    expect(applied).toEqual({ slabsSet: 1, categoriesSynced: 1 });
    const [darzRow] = await db.select({ gst: items.gstRateBps }).from(items).where(eq(items.id, darz));
    expect(darzRow?.gst).toBe(0);
    expect(await category(darz)).toBe("pharmacy_exempt");
    expect(await category(fx.item.crocin)).toBe("pharmacy_5");
    // A slab that disagrees is only replaced when asked to.
    expect(await category(fx.item.calpol)).toBe("pharmacy");
    const again = await applyGstSlabPlan(db, HEAD, await gstSlabPlan(db), { overwrite: true });
    expect(again).toEqual({ slabsSet: 1, categoriesSynced: 1 });
    expect(await category(fx.item.calpol)).toBe("pharmacy_5");
    expect((await gstSlabPlan(db)).every((p) => p.verdict === "ok" && !p.categoryStale)).toBe(true);
  });

  it("bills at the corrected slab once the category follows it", async () => {
    await withTx(db, (tx) => updateItem(tx, HEAD, fx.item.crocin, { gstRateBps: 500 }));
    await applyGstSlabPlan(db, HEAD, await gstSlabPlan(db));
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30, expiryDate: "2027-12-31", at: MON });
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, r.dispense.id, MON3);
    const b = await billDispense(db, fx.pharmacist.actor, r.dispense.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON3);
    const lines = await db.select({ rateBps: invoiceLines.rateBps }).from(invoiceLines).where(eq(invoiceLines.invoiceId, b.invoiceId!));
    expect(lines.map((l) => l.rateBps)).toEqual([500]);
  });
});
