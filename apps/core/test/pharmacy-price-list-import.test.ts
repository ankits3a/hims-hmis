import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { addMedicine, addSalt, medicineIdsByBrandNames, medicinesByIds, parseComposition, twinFormOf, twinStrengthAgrees } from "../src/modules/formulary";
import { effectiveRegulation, listItems } from "../src/modules/materials";
import { importPriceList, matchPriceList, parsePack, rupeesToPaise } from "../src/modules/pharmacy/price-list-import";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-04 — a vendor's list (manufacturer, brand, composition, packing) into the item master: each row
 * matched to the national catalogue, reviewed, and the ticked ones made through `createStockDrug`.
 */
describe("a vendor's price list into the item master", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.items.manage");
  });
  afterEach(() => { fx.unregister(); });

  it("reads a pack and a price the way vendors write them", () => {
    expect(parsePack("10x15", "tablet")).toEqual({ packType: "tablet_strip", packSize: 15, outer: 10 });
    expect(parsePack("1 x 10 Cap", "")).toEqual({ packType: "capsule_strip", packSize: 10, outer: 1 });
    expect(parsePack("100 ml", "syrup")).toEqual({ packType: "bottle", packSize: 1, outer: 1 });
    expect(parsePack("1 vial", "injection")).toEqual({ packType: "vial", packSize: 1, outer: 1 });
    expect(parsePack("15 gm", "cream")).toEqual({ packType: "tube", packSize: 1, outer: 1 });
    // Aptus Drugs' quotation (owner 2026-10-04): the packing is a product of counts, the strip is the last.
    expect(parsePack("4*5*10", "tablet")).toEqual({ packType: "tablet_strip", packSize: 10, outer: 20 });
    expect(parsePack("10*1*6", "tablet")).toEqual({ packType: "tablet_strip", packSize: 6, outer: 10 });
    expect(parsePack("10*10", "")).toEqual({ packType: "tablet_strip", packSize: 10, outer: 10 });
    expect(parsePack("100 TAB", "")).toEqual({ packType: "tablet_strip", packSize: 100, outer: 1 });
    expect(parsePack("5*2ML", "solution for injection")).toEqual({ packType: "ampoule", packSize: 1, outer: 5 });
    expect(parsePack("10*2ML*5", "injection")).toEqual({ packType: "ampoule", packSize: 1, outer: 50 });
    expect(parsePack("1'S", "powder for solution for injection")).toEqual({ packType: "vial", packSize: 1, outer: 1 });
    expect(parsePack("25*21.8 GM", "sachet")).toEqual({ packType: "sachet", packSize: 1, outer: 25 });
    expect(parsePack("100ML", "solution for infusion")).toEqual({ packType: "bottle", packSize: 1, outer: 1 });
    expect(rupeesToPaise("₹ 35.50")).toBe(3550);
    expect(rupeesToPaise("Rs.1,120/-")).toBe(112_000);
    expect(rupeesToPaise("")).toBeNull();
  });

  it("reads a vendor's composition column and the form a row names", () => {
    expect(parseComposition("TELMISARTAN 40 mg & HYDROCHLOROTHIAZIDE 12.5")).toEqual([
      { moiety: "telmisartan", amount: { mg: 40, perMl: null }, raw: "40" },
      { moiety: "hydrochlorothiazide", amount: { mg: 12.5, perMl: null }, raw: "12.5" },
    ]);
    expect(parseComposition("AMOXYCILLIN 500MG+POTASSIUM CLAVUANATE DILUTED 125MG")?.map((c) => c.moiety)).toEqual(["amoxicillin", "potassium clavulanate"]);
    expect(parseComposition("SUCRALFATE 500MG/5ML")?.[0]?.amount).toEqual({ mg: 500, perMl: 5 });
    expect(parseComposition("CEFTRIAXONE 1GM")?.[0]?.amount).toEqual({ mg: 1000, perMl: null });
    expect(parseComposition("CHOLECALCIFEROL 60,000 I.U")?.[0]).toMatchObject({ moiety: "colecalciferol", amount: null, raw: "60000" });
    expect(parseComposition("A 1MG+B 2MG+C 3MG+D 4MG+E 5MG+F 6MG+G 7MG")).toBeNull(); // a blend, not a drug to template
    expect(twinFormOf("SAZOTEL-40", "10*15", "TELMISARTAN 40MG")).toEqual({ form: "solid", modifiedRelease: false });
    expect(twinFormOf("SEYTRI 1GM", "1'S", "CEFTRIAXONE 1000MG")?.form).toBe("injection");
    expect(twinFormOf("DROSIT", "5*2ML", "DROTAVERINE HCL 20MG")?.form).toBe("injection");
    expect(twinFormOf("LITRATE", "200ML", "CALCIUM CARBONATE 625MG")?.form).toBe("oral_liquid");
    expect(twinFormOf("MOXYFLIN", "5ML", "MOXIFLOXACIN OPHTHALMIC SOL")?.form).toBe("eye_drop");
    expect(twinFormOf("SAZOMET 1000", "10*15", "METFORMIN 1000MG SR")).toEqual({ form: "solid", modifiedRelease: true });
    // "-MR" on an NSAID brand is a muscle relaxant, not modified release.
    expect(twinFormOf("ETOHIT-MR", "10*10", "ETORICOXIB 60MG +THIOCOLCHICOSIDE 4MG")?.modifiedRelease).toBe(false);
    // Each component its own strength: two 75s need two 75s; a generic name binds a strength to its moiety.
    const clopAsp = { components: parseComposition("CLOPIDOGREL 75MG + ASPIRIN 75MG")!, form: "solid" as const, modifiedRelease: false };
    expect(twinStrengthAgrees(clopAsp, "Aspirin 150 mg and clopidogrel 75 mg oral tablet", "150 mg")).toBe(false);
    expect(twinStrengthAgrees(clopAsp, "Oprin (aspirin and clopidogrel) 75 mg + 75 mg oral tablet", "75 mg")).toBe(true);
    const levOz = { components: parseComposition("LEVOFLOXACIN 250MG + ORNIDAZOLE 500MG")!, form: "solid" as const, modifiedRelease: false };
    expect(twinStrengthAgrees(levOz, "Levaz OZ (levofloxacin and ornidazole) 250 mg + 500 mg oral tablet", "250 mg")).toBe(true);
    expect(twinStrengthAgrees(levOz, "Levofloxacin 500 mg and ornidazole 250 mg oral tablet", "500 mg")).toBe(false);
  });

  it("matches each row to the catalogue, says when the brand is already stocked, and writes nothing", async () => {
    const before = (await listItems(db, { class: "drug" })).length;
    const rows = await matchPriceList(db, [
      { manufacturer: "Abbott", brand: "Brufen 400", composition: "Ibuprofen 400 mg", pack: "10x15", mrp: "₹ 42.10", gst: "5%" },
      { manufacturer: "GSK", brand: "Crocin 500", composition: "Paracetamol 500mg", pack: "10x15" },
      { manufacturer: "Nobody", brand: "Zzqx 99", composition: "", pack: "" },
    ]);
    expect(rows[0]).toMatchObject({ best: { medicineId: fx.med.ibuprofen, schedule: "H" }, existing: null, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210 });
    expect(rows[1]!.best?.medicineId).toBe(fx.med.crocin);
    expect(rows[1]!.existing).not.toBeNull(); // Crocin 500 is already in the item master
    expect(rows[2]!.best).toBeNull();
    expect((await listItems(db, { class: "drug" })).length).toBe(before);
  });

  it("makes each ticked row an item with its pack and MRP; a duplicate is refused for that row alone", async () => {
    const results = await importPriceList(db, fx.incharge.actor, [
      { line: 1, medicineId: fx.med.ibuprofen, brand: "Brufen 400", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210, storage: "ambient" },
      { line: 2, medicineId: fx.med.crocin, brand: "Crocin 500", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 3000, storage: "ambient" },
    ]);
    expect(results[0]).toMatchObject({ line: 1, ok: true });
    expect(results[1]).toMatchObject({ line: 2, ok: false, code: "duplicate_code" });
    const made = results[0]!.ok ? results[0]! : null;
    const reg = await effectiveRegulation(db, made!.itemId, new Date());
    expect(reg).toMatchObject({ mrpDefaultPaise: 4210, mrpUom: "strip" });
  });

  it("a person without the sale-item right is refused once, not once per row", async () => {
    await expect(importPriceList(db, fx.aide.actor, [
      { line: 1, medicineId: fx.med.ibuprofen, brand: "Brufen 400", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210, storage: "ambient" },
    ])).rejects.toMatchObject({ code: "permission_denied" });
  });

  describe("a brand the catalogue has never heard of (owner 2026-10-04, the Aptus Drugs list)", () => {
    let telmisartan40: string;
    beforeEach(async () => {
      telmisartan40 = await withTx(db, async (tx) => {
        const telmi = await addSalt(tx, fx.pharmacist.actor, { name: "Telmisartan", drugClass: "arb" });
        return (await addMedicine(tx, fx.pharmacist.actor, {
          brandName: "Telmisartan 40 mg oral tablet", form: "Oral tablet", routeClass: "systemic", strengthLabel: "40 mg", scheduleFlag: "H",
          salts: [{ saltId: telmi.saltId, strength: "40 mg" }],
        })).medicineId;
      });
    });

    it("offers the catalogue drug of the same composition, strength and form as a twin, and reads the packing", async () => {
      const [row] = await matchPriceList(db, [{ manufacturer: "Hauz Pharma", brand: "SAZOTEL-40", composition: "TELMISARTAN 40MG", pack: "10*15", mrp: "1060" }]);
      expect(row).toMatchObject({
        best: null, existing: null, packType: "tablet_strip", packSize: 15, outer: 10, mrpPerPackPaise: 106_000,
        twin: { medicineId: telmisartan40, schedule: "H", newName: "Sazotel-40 (telmisartan 40 mg oral tablet)" },
      });
    });

    it("a catalogue brand in another strength or form is not offered as the vendor's row", async () => {
      // The catalogue knows Crocin 500 tablets only: CROCIN 650 and a Brufen syrup are not those.
      const rows = await matchPriceList(db, [
        { brand: "CROCIN 650", composition: "PARACETAMOL 650MG", pack: "10*15" },
        { brand: "BRUFEN 400 SYP", composition: "IBUPROFEN 400MG/5ML", pack: "60ML" },
        { brand: "BRUFEN 400", composition: "IBUPROFEN 400MG", pack: "10*15" },
      ]);
      expect(rows[0]!.best).toBeNull();
      expect(rows[1]!.best).toBeNull();
      expect(rows[2]!.best?.medicineId).toBe(fx.med.ibuprofen);
    });

    it("no twin when a strength or the form disagrees — a wrong template is a wrong drug", async () => {
      const rows = await matchPriceList(db, [
        { brand: "SAZOTEL-80", composition: "TELMISARTAN 80MG", pack: "10*10" },
        { brand: "SAZOTEL SYP", composition: "TELMISARTAN 40MG", pack: "100ML" },
        { brand: "SAZOTEL-H 40", composition: "TELMISARTAN 40MG & HYDROCHLOROTHIAZIDE 12.5MG", pack: "10*15" },
      ]);
      expect(rows.map((r) => r.twin)).toEqual([null, null, null]);
    });

    it("a catalogue brand of the same NAME but another composition is not offered as the match", async () => {
      // Brufen is ibuprofen in the catalogue; this vendor's "BRUFEN 500" says paracetamol.
      const [row] = await matchPriceList(db, [{ brand: "BRUFEN 500", composition: "PARACETAMOL 500MG", pack: "10*10" }]);
      expect(row!.best).toBeNull();
      expect([fx.med.crocin, fx.med.calpol]).toContain(row!.twin?.medicineId);
    });

    it("the same brand as a syrup is not 'already an item' because the tablet is", async () => {
      const [row] = await matchPriceList(db, [{ brand: "CROCIN 500 SYP", composition: "PARACETAMOL 250MG/5ML", pack: "60ML" }]);
      expect(row!.existing).toBeNull();
    });

    it("two sizes of one brand and form become two items, told apart by the size", async () => {
      const rows = await matchPriceList(db, [
        { brand: "MULTIGING", composition: "MULTIVITAMIN SYRUP", pack: "100ML" },
        { brand: "MULTIGING", composition: "MULTIVITAMIN SYRUP", pack: "200ML" },
        { brand: "MULTIGING", composition: "MULTIVITAMIN", pack: "10*10" },
      ]);
      expect(rows.map((r) => r.variant)).toEqual(["100ml", "200ml", null]);
    });

    it("importing a twin adds the brand to the catalogue with the template's composition, then the item; once", async () => {
      await grantPermissionToRole(db, fx.registry, "pharmacy", "formulary.manage");
      const row = { line: 1, medicineId: telmisartan40, brand: "SAZOTEL-40", packType: "tablet_strip" as const, packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 7067, storage: "ambient" as const, twin: true };
      const [made] = await importPriceList(db, fx.incharge.actor, [row]);
      expect(made).toMatchObject({ ok: true });
      const id = (await medicineIdsByBrandNames(db, ["Sazotel-40 (telmisartan 40 mg oral tablet)"])).get("sazotel-40 (telmisartan 40 mg oral tablet)");
      expect(id).toBeDefined();
      const [twin, template] = [(await medicinesByIds(db, [id!])).get(id!)!, (await medicinesByIds(db, [telmisartan40])).get(telmisartan40)!];
      expect(twin).toMatchObject({ form: template.form, strengthLabel: template.strengthLabel, scheduleFlag: "H", routeClass: "systemic" });
      expect(twin.salts).toEqual(template.salts);
      // The same row again: the catalogue brand is found, not added twice; the item is refused as a duplicate.
      const [again] = await importPriceList(db, fx.incharge.actor, [row]);
      expect(again).toMatchObject({ ok: false, code: "duplicate_code" });
      expect((await medicineIdsByBrandNames(db, ["Sazotel-40 (telmisartan 40 mg oral tablet)"])).size).toBe(1);
    });

    it("a twin needs formulary.manage, asked once", async () => {
      const row = { line: 1, medicineId: telmisartan40, brand: "SAZOTEL-40", packType: "tablet_strip" as const, packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 7067, storage: "ambient" as const, twin: true };
      await expect(importPriceList(db, fx.aide.actor, [row])).rejects.toMatchObject({ code: "permission_denied" });
    });
  });
});
