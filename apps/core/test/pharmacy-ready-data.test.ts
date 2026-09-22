import { eq } from "drizzle-orm";
import { withTx } from "../src/kernel/db/client";
import { formularyMedicines, stockBatches, vendors } from "../src/kernel/db/schema";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { addMedicine, saltIdsByNames } from "../src/modules/formulary";
import { availableQty, balances, listItems, releaseReservation, reserveStock } from "../src/modules/materials";
import { getSaleItem, shelfLocationsFor } from "../src/modules/pharmacy";
import { setupTestDb, truncateAll } from "./helpers/db";
import { issueRx, line, seedPharmacyBase } from "./helpers/pharmacy";
import { parseCsv, resolvePerson, splitCsvLine, toCsvLine } from "../scripts/pharmacy-shelf-common";
import {
  applySchedulePlan, isExternalPreparation, moietyKey, nrcesScheduledSubstances, schedulePlan, statutoryIndex, strictest,
} from "../scripts/set-schedule-flags";
import {
  buildStarterList, chooseBrand, codeFor, compositionMatches, doseFormAllowed, nlemWants, parseComposition, renderStarterCsv,
} from "../scripts/build-pharmacy-starter-list";
import { applyShelf, planShelf } from "../scripts/load-pharmacy-shelf";
import { TRIAL_VENDOR_CODE, applyTrialStock, planTrialStock, requireTrialConsent } from "../scripts/load-trial-stock";
import { TRIAL_WIPE_REF_TYPE, applyWipe, planWipe } from "../scripts/wipe-trial-stock";
import { applyOpeningStock, expiryOf, namesFor, planOpeningStock, rupeesToPaise } from "../scripts/import-opening-stock";
import type { Bundle, BundleBrand } from "../scripts/build-pharmacy-starter-list";
import type { Person } from "../scripts/pharmacy-shelf-common";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE PHARMACY-READY SCRIPTS (owner rulings 2026-09-22) ═══
 *
 * `scripts/` is not type-checked by the core tsconfig — this file importing all six is what makes a
 * type error in any of them fail CI. Beyond that, each script's promise is pinned where it could break:
 * a pharmacist's schedule flag is never overwritten; the shelf loader refuses a whole list over one bad
 * brand and a rerun writes nothing; trial stock passes the REAL QC gate and is findable; the wipe leaves
 * nothing sellable and refuses a batch a pick holds; the opening sheet refuses what the gate would.
 */
describe("pharmacy-ready scripts", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let pharmacist: Person;
  let head: Person;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    pharmacist = { ...fx.pharmacist.actor, id: fx.pharmacist.id, username: "ph.mehta", fullName: "ph.mehta" } as Person;
    // The service functions take an actor; the route guard is what checks permissions, and these scripts
    // re-check it in `resolvePerson` (pinned below). The incharge plays the materials head here.
    head = { ...fx.incharge.actor, id: fx.incharge.id, username: "ph.incharge", fullName: "ph.incharge" } as Person;
  });
  afterEach(() => { fx.unregister(); });

  // ═══════════════════════════ shared ═══════════════════════════

  it("CSV: quoted commas survive a round trip, # lines are comments, and the named person must hold the permission", async () => {
    const brand = "Augmentin (amoxicillin, clavulanate) 500 mg + 125 mg oral tablet";
    expect(splitCsvLine(toCsvLine(["X1", brand, 500]))).toEqual(["X1", brand, "500"]);
    const f = parseCsv(`# provenance\ncode,brand_name\nX1,"${brand}"\n`);
    expect(f.comments).toEqual(["provenance"]);
    expect(f.rows[0]!.cells.brand_name).toBe(brand);
    await expect(resolvePerson(db, "ph.mehta", "materials.items.manage", "--as")).rejects.toThrow(/does not hold materials.items.manage/);
    await expect(resolvePerson(db, "nobody.here", "pharmacy.sale_items.manage", "--as")).rejects.toThrow(/no active account/);
    await expect(resolvePerson(db, "ph.mehta", "pharmacy.sale_items.manage", "--as")).resolves.toMatchObject({ id: fx.pharmacist.id });
  });

  // ═══════════════════════════ 1. schedule flags ═══════════════════════════

  it("schedule flags: statute by moiety, strictest wins, the external-use scope note, and NRCeS single-substance rows only", () => {
    expect(moietyKey("Amlodipine besilate")).toBe("amlodipine");
    expect(moietyKey("Tramadol hydrochloride")).toBe("tramadol");
    const index = statutoryIndex();
    expect(index.get("alprazolam")?.flag).toBe("H1");
    expect(index.get("methylphenidate")?.flag).toBe("X");
    expect(index.get("ibuprofen")?.flag).toBe("H");
    expect(index.get("paracetamol")).toBeUndefined();
    expect(strictest(["H", null, "H1"])).toBe("H1");
    expect(strictest([null, null])).toBeNull();
    expect(isExternalPreparation("topical", "Cutaneous cream")).toBe(true);
    expect(isExternalPreparation("topical", "Eye drops")).toBe(false);
    const csv = "generic_sctid,substance_sctids,classification_of_drug,drug_type\n1,111,Schedule H,\n2,222 | 333,Schedule H,\n3,444,,255631004;Antibiotic\n";
    const n = nrcesScheduledSubstances(csv);
    expect(n.get("111")?.flag).toBe("H");
    expect(n.has("222")).toBe(false); // a combination's class is not attributed to one substance
    expect(n.get("444")?.basis).toMatch(/Antibiotics/);
  });

  it("schedule flags: fills a blank, never overwrites a pharmacist's flag, leaves the unlisted NULL, and a rerun writes nothing", async () => {
    const [ibu] = [...(await saltIdsByNames(db, ["ibuprofen"])).values()];
    const { medicineId: blank } = await withTx(db, (tx) => addMedicine(tx, pharmacist, { brandName: "Ibugesic 400", form: "tablet", routeClass: "systemic", strengthLabel: "400 mg", salts: [{ saltId: ibu!, strength: "400 mg" }] }));
    const { medicineId: gel } = await withTx(db, (tx) => addMedicine(tx, pharmacist, { brandName: "Brufen gel", form: "Cutaneous gel", routeClass: "topical", strengthLabel: "10%", salts: [{ saltId: ibu!, strength: "10%" }] }));
    const plan = await schedulePlan(db, new Map());
    const row = (id: string) => plan.rows.find((r) => r.medicineId === id)!;
    expect(row(blank)).toMatchObject({ derived: "H", verdict: "set" });
    expect(row(gel)).toMatchObject({ derived: null, verdict: "unclassified" }); // Schedule H's external-use exclusion
    expect(row(fx.med.alprax)).toMatchObject({ current: "X", derived: "H1", verdict: "differs" });
    expect(row(fx.med.crocin)).toMatchObject({ derived: null, verdict: "unclassified" });
    expect(await applySchedulePlan(db, pharmacist, plan)).toEqual({ written: 1 });
    const flags = new Map((await db.select({ id: formularyMedicines.id, f: formularyMedicines.scheduleFlag }).from(formularyMedicines)).map((m) => [m.id, m.f]));
    expect(flags.get(blank)).toBe("H");
    expect(flags.get(fx.med.alprax)).toBe("X"); // the person's decision stands
    expect(flags.get(fx.med.crocin)).toBe("OTC");
    expect((await applySchedulePlan(db, pharmacist, await schedulePlan(db, new Map()))).written).toBe(0);
  });

  // ═══════════════════════════ 2. the starter list ═══════════════════════════

  it("starter list: composition matching, dose forms, the brand rule and stable codes", () => {
    const co = parseComposition("Amoxicillin (500/1 milligram/Tablet) + Clavulanate potassium (125/1 milligram/Tablet)")!;
    expect(co.map((c) => [c.key, c.amount, c.per])).toEqual([["amoxicillin", 500, "unit"], ["clavulanate", 125, "unit"]]);
    const want = nlemWants({ medicine: "Amoxicillin + Clavulanic acid", strength: "500 mg + 125 mg" })!;
    expect(compositionMatches(want, co)).toBe(true);
    expect(compositionMatches(nlemWants({ medicine: "Amoxicillin + Clavulanic acid", strength: "250 mg + 125 mg" })!, co)).toBe(false);
    expect(compositionMatches(nlemWants({ medicine: "Paracetamol", strength: "125 mg/5 mL" })!, parseComposition("Paracetamol (125/5 milligram/Milliliter)")!)).toBe(true);
    expect(compositionMatches(nlemWants({ medicine: "Clotrimazole", strength: "1%" })!, parseComposition("Clotrimazole (1/100 gram/Gram)")!)).toBe(true);
    expect(doseFormAllowed({ form: "tablet", formText: "Tablet" }, "Oral tablet")).toBe(true);
    expect(doseFormAllowed({ form: "tablet", formText: "Tablet" }, "Prolonged-release oral tablet")).toBe(false);
    expect(doseFormAllowed({ form: "tablet", formText: "Dispersible Tablet" }, "Dispersible oral tablet")).toBe(true);
    const b = (brand: string, manufacturer: string): BundleBrand => ({ medicineSctid: brand, medicineName: `${brand} 500`, brand, genericSctid: "g", manufacturer });
    const pick = chooseBrand([b("Obscura", "Tiny Labs"), b("Dolo", "Micro Labs Limited"), b("Crocin", "GlaxoSmithKline Pharmaceuticals Limited")], () => true, new Map([["crocin", 30], ["dolo", 12]]));
    expect(pick?.brand).toBe("Crocin"); // a named maker, then the biggest brand family
    expect(chooseBrand([b("Obscura", "Tiny Labs")], () => false)).toBeUndefined();
    const taken = new Set<string>();
    expect(codeFor("Dolo", "650 mg", "Oral tablet", taken)).toBe("DOLO650");
    expect(codeFor("Dolo", "650 mg", "Oral tablet", taken)).toBe("DOLO650-2");
    expect(codeFor("Calpol", "250 mg/5 mL", "Oral suspension", taken)).toBe("CALPOL250L");
  });

  it("starter list: the prescribed half is read from THIS database's prescriptions; an NLEM line gets one held brand", async () => {
    await issueRx(db, fx, [line({ drug: "Brufen 400", medicineId: fx.med.ibuprofen }), line({ drug: "Azee 500", medicineId: fx.med.azithro }), line({ drug: "something free-text" })]);
    const bundle: Bundle = {
      generics: new Map([["G-PARA-500", { sctid: "G-PARA-500", name: "Paracetamol 500 mg oral tablet", doseForm: "Oral tablet", composition: parseComposition("Paracetamol (500/1 milligram/Tablet)") }]]),
      brandsByGeneric: new Map([["G-PARA-500", [
        { medicineSctid: "B1", medicineName: "Crocin 500", brand: "Crocin", genericSctid: "G-PARA-500", manufacturer: "GlaxoSmithKline Pharmaceuticals Limited" },
        { medicineSctid: "B2", medicineName: "Calpol 500", brand: "Calpol", genericSctid: "G-PARA-500", manufacturer: "GlaxoSmithKline Pharmaceuticals Limited" },
        { medicineSctid: "B3", medicineName: "Not In Formulary 500", brand: "Nif", genericSctid: "G-PARA-500", manufacturer: "Cipla Limited" },
      ]]]),
      brandBySctid: new Map(),
      dpco: [],
    };
    for (const list of bundle.brandsByGeneric.values()) for (const x of list) bundle.brandBySctid.set(x.medicineSctid, x);
    const { rows, report } = await buildStarterList(db, bundle, new Map(), { target: 3 });
    expect(report).toMatchObject({ prescribedMedicines: 2, prescribedLines: 3, freeTextLines: 1 });
    expect(rows.map((r) => [r.brandName, r.why, r.schedule])).toEqual([
      ["Calpol 500", "nlem", "OTC"], ["Azee 500", "prescribed_in_opd", "H1"], ["Brufen 400", "prescribed_in_opd", "H"],
    ]);
    expect(rows.find((r) => r.brandName === "Azee 500")!).toMatchObject({ code: "AZEE500", rack: "H1-1" });
    const calpol = rows.find((r) => r.brandName === "Calpol 500")!;
    expect(calpol).toMatchObject({ code: "CALP500", nlemCode: "2.1.5", gstRateBps: 500, hsnCode: "3004", packUom: "strip", packMultiplier: 10 });
    expect(rows.find((r) => r.brandName === "Brufen 400")!.prescribedCount).toBe(1);
    const csv = renderStarterCsv(rows, report, "test");
    expect(csv).toMatch(/CA TO CONFIRM/);
    expect(csv).not.toMatch(/1200/);
    expect(parseCsv(csv).rows).toHaveLength(3);
  });

  // ═══════════════════════════ 3–6. shelf, trial stock, wipe, opening stock ═══════════════════════════

  const LIST = (rows: string[]): string =>
    `code,brand_name,base_uom,pack_uom,pack_multiplier,hsn_code,gst_rate_bps,rack\n${rows.join("\n")}\n`;

  async function loadShelf(): Promise<void> {
    const plan = await planShelf(db, parseCsv(LIST(["BRUF400,Brufen 400,tablet,strip,10,3004,500,A1", "CALP500,Calpol 500,tablet,strip,10,3004,500,A2"])));
    await applyShelf(db, head, pharmacist, plan);
  }

  it("shelf loader: one unknown brand refuses the whole list; then items, sale registrations and racks land, and a rerun writes nothing", async () => {
    const bad = await planShelf(db, parseCsv(LIST(["BRUF400,Brufen 400,tablet,strip,10,3004,500,A1", "NOPE1,No Such Brand,tablet,strip,10,3004,500,A1"])));
    expect(bad.refusals).toBe(1);
    await expect(applyShelf(db, head, pharmacist, bad)).rejects.toThrow(/refusing to apply/);
    expect((await listItems(db, { class: "drug" })).some((i) => i.code === "BRUF400")).toBe(false);

    const plan = await planShelf(db, parseCsv(LIST(["BRUF400,Brufen 400,tablet,strip,10,3004,500,A1", "CALP500,Calpol 500,tablet,strip,10,3004,500,A2"])));
    expect(plan).toMatchObject({ creates: 1, adopts: 1, refusals: 0, saleItemsToRegister: 1, racksToSet: 2 });
    expect(plan.rows[1]!.notes.join()).toMatch(/slab on file 1200 ≠ list 500 — left alone/);
    expect(await applyShelf(db, head, pharmacist, plan)).toEqual({ itemsCreated: 1, saleItemsRegistered: 1, racksSet: 2 });
    const brufen = (await listItems(db, { class: "drug" })).find((i) => i.code === "BRUF400")!;
    expect(brufen).toMatchObject({ formularyMedicineId: fx.med.ibuprofen, gstRateBps: 500, hsnCode: "3004" });
    expect(await getSaleItem(db, brufen.id)).toBeDefined();
    expect((await shelfLocationsFor(db, fx.storeId, [brufen.id])).get(brufen.id)).toBe("A1");
    const again = await planShelf(db, parseCsv(LIST(["BRUF400,Brufen 400,tablet,strip,10,3004,500,A1", "CALP500,Calpol 500,tablet,strip,10,3004,500,A2"])));
    expect(await applyShelf(db, head, pharmacist, again)).toEqual({ itemsCreated: 0, saleItemsRegistered: 0, racksSet: 0 });
  });

  it("trial stock: refuses without the words; every batch TRIAL-, every line through QC, one near-expiry batch per item; a rerun posts nothing", async () => {
    expect(() => requireTrialConsent(["--apply"])).toThrow(/REFUSES without --i-understand-trial/);
    expect(() => requireTrialConsent(["--apply", "--i-understand-trial"])).not.toThrow();
    await loadShelf();
    const now = new Date();
    const plan = await planTrialStock(db, now);
    expect(plan.items).toBe(4); // crocin, calpol, azithro from the fixture + brufen
    const done = await applyTrialStock(db, head, pharmacist, plan, now);
    expect(done.vendorCreated).toBe(true);
    expect(done.grnsPosted).toBe(2);
    const batches = await db.select().from(stockBatches);
    expect(batches.length).toBe(done.lines);
    expect(batches.every((b) => b.batchNo.startsWith("TRIAL-"))).toBe(true);
    const a = batches.filter((b) => b.batchNo.endsWith("-A"));
    expect(a).toHaveLength(4);
    for (const b of a) {
      const days = (Date.parse(b.expiryDate!) - now.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(58);
      expect(days).toBeLessThan(92);
    }
    expect(await availableQty(db, fx.storeId, fx.item.crocin, now)).toBeGreaterThan(0);
    const [v] = await db.select().from(vendors).where(eq(vendors.code, TRIAL_VENDOR_CODE));
    expect(v).toMatchObject({ legalName: "TRIAL STOCK — NOT A SUPPLIER", status: "active" });
    const rerun = await applyTrialStock(db, head, pharmacist, await planTrialStock(db, now), now);
    expect(rerun.grnsPosted).toBe(0);
  });

  it("wipe: a batch a pick holds refuses the wipe; otherwise every trial unit is written off by a findable ledger row, nothing is sellable, and the vendor is suspended", async () => {
    await loadShelf();
    const now = new Date();
    await applyTrialStock(db, head, pharmacist, await planTrialStock(db, now), now);
    const held = (await balances(db, { resourceId: fx.storeId }))[0]!;
    const reservation = await withTx(db, (tx) => reserveStock(tx, pharmacist, { resourceId: fx.storeId, batchId: held.batchId, qty: 1, refType: "pharmacy_dispense", refId: "D1", expiresAt: new Date(now.getTime() + 3_600_000) }));
    const blocked = await planWipe(db);
    expect(blocked.blocked).toHaveLength(1);
    await expect(applyWipe(db, head, blocked, now)).rejects.toThrow(/reserved or frozen/);
    await withTx(db, (tx) => releaseReservation(tx, pharmacist, reservation.reservationId));

    const plan = await planWipe(db);
    expect(plan.onHandUnits).toBe(plan.receivedUnits);
    const done = await applyWipe(db, head, plan, now);
    expect(done).toMatchObject({ writtenOff: plan.lines.length, units: plan.receivedUnits, vendorSuspended: true });
    expect((await balances(db, { resourceId: fx.storeId })).every((b) => b.qtyOnHand === 0)).toBe(true);
    expect(await availableQty(db, fx.storeId, fx.item.crocin, now)).toBe(0);
    const again = await planWipe(db);
    expect(again).toMatchObject({ onHandUnits: 0, wipedUnits: plan.receivedUnits, leftUnits: 0, lines: [] });
    const rows = await db.execute(`select count(*)::int as n from stock_ledger where ref_type = '${TRIAL_WIPE_REF_TYPE}'`);
    expect((rows.rows[0] as { n: number }).n).toBe(plan.lines.length);
  });

  it("opening stock: reads the pharmacist's sheet, refuses what the gate would, and receives the rest through capture → QC → post exactly once", async () => {
    expect(expiryOf("08/2027")).toBe("2027-08-31");
    expect(expiryOf("02/28")).toBe("2028-02-29");
    expect(expiryOf("13/2027")).toBeNull();
    expect(rupeesToPaise("35.5")).toBe(3550);
    expect(rupeesToPaise("35.555")).toBeNull();
    expect(namesFor({ code: "ZEPTOL200", name: "Zeptol (carbamazepine) 200 mg oral tablet" })).toContain("zeptol 200");
    await loadShelf();
    const now = new Date();
    const y = now.getUTCFullYear() + 1;
    const sheet = (rows: string[]): string => `brand,batch,expiry,mrp_per_pack,pack_size,packs,rack,supplier_name,purchase_rate_per_pack\n${rows.join("\n")}\n`;
    const bad = sheet([
      `Crocn 500,C1,08/${String(y)},40.00,10,3,,,`,
      `Brufen 400,B1,08/${String(y)},35.50,15,2,,,`,
      `Calpol 500,K1,01/2020,40.00,10,1,,,`,
    ]);
    const refused = await planOpeningStock(db, parseCsv(bad), bad, now);
    expect(refused.refusals).toBe(3);
    expect(refused.rows[0]!.reasons.join()).toMatch(/did you mean: .*Crocin 500/);
    expect(refused.rows[1]!.reasons.join()).toMatch(/not whole paise per unit/);
    expect(refused.rows[2]!.reasons.join()).toMatch(/expired/);

    const good = sheet([`Crocin 500,C1,08/${String(y)},40.00,10,3,R-9,,28.00`, `Brufen 400,B1,08/${String(y)},45.00,15,2,,,`]);
    const plan = await planOpeningStock(db, parseCsv(good), good, now);
    expect(plan).toMatchObject({ refusals: 0, newUoms: 1, needsVendor: true, units: 60 });
    await expect(applyOpeningStock(db, { storekeeper: head, qc: pharmacist, head: null }, plan, now)).rejects.toThrow(/--head/);
    const done = await applyOpeningStock(db, { storekeeper: head, qc: pharmacist, head }, plan, now);
    expect(done).toMatchObject({ posted: 1, awaiting: 0, unitsPosted: 60, uomsAdded: 1, racksSet: 1, vendorCreated: true });
    expect(await availableQty(db, fx.storeId, fx.item.crocin, now)).toBe(30);
    const again = await planOpeningStock(db, parseCsv(good), good, now);
    expect(again.grns.every((g) => g.state === "posted")).toBe(true);
    expect((await applyOpeningStock(db, { storekeeper: head, qc: pharmacist, head }, again, now)).posted).toBe(0);
    expect(await availableQty(db, fx.storeId, fx.item.crocin, now)).toBe(30);
  });

  it("the fixture's permissions are what the scripts would demand of real people", async () => {
    await grantPermissionToRole(db, fx.registry, "pharmacy", "formulary.manage");
    await expect(resolvePerson(db, "ph.mehta", "formulary.manage", "--as")).resolves.toMatchObject({ username: "ph.mehta" });
  });
});
