import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, formularySalts, pharmacyDispenses } from "../../kernel/db/schema";
import { addMedicine, addSalt } from "../formulary";
import { registerItem } from "../materials";
import { amountsIn, matchOpenLines, moietyKey, parseDrugText } from "./auto-match";
import { claimDispense, findAtCounter } from "./claim";
import { getDispense, listQueue } from "./queue";
import { registerSaleItem } from "./sale-items";
import { precheckTicket, verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * 2026-09-23 — A GENERIC PRESCRIPTION OPENS ALREADY MATCHED TO THE STOCKED BRAND.
 *
 * Production's dispense 01M36QQXY3S0YBWAN7DQ9M31AJ: five lines from a CDS regimen template, four of
 * them free words and one a formulary GENERIC nobody stocks, every one opened with no item, no batch
 * and no price. The fixture shelf below is production's shape, measured on the prod-like scratch DB:
 * CDS brand names carrying their composition in the name, CDS forms ("Oral tablet"), and the
 * importer's defect of writing a combination's FIRST strength onto every moiety row (Augmentin DUO
 * reads "500 mg/" for clavulanic acid).
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

type Shelf = {
  dolo: string; pacimol: string; augmentin: string; pan: string; mox: string; montairLc: string;
  genericAmox200: string; brandCalpol650: string;
  item: { dolo: string; pacimol: string; augmentin: string; pan: string; mox: string; montairLc: string };
};

async function prodShelf(db: Db, fx: PharmacyFixture): Promise<Shelf> {
  return withTx(db, async (tx) => {
    const a = fx.pharmacist.actor;
    const salt = async (name: string, aliases: string[] = []): Promise<string> => (await addSalt(tx, a, { name, aliases, drugClass: null })).saltId;
    const paraId = (await tx.select({ id: formularySalts.id }).from(formularySalts).where(eq(formularySalts.name, "Paracetamol")))[0]!.id; // the fixture's own
    const amox = await salt("amoxicillin");
    const clav = await salt("clavulanic acid");
    const panto = await salt("pantoprazole");
    const levo = await salt("levocetirizine");
    const monte = await salt("montelukast");
    await salt("ambroxol");
    const med = async (brandName: string, form: string, strength: string, salts: string[], scheduleFlag: string | null = null, code: string | null = null): Promise<string> => {
      const m = await addMedicine(tx, a, {
        brandName, form, routeClass: "systemic", strengthLabel: strength, scheduleFlag,
        salts: salts.map((saltId) => ({ saltId, strength })), acknowledgeIntraFdc: true,
      });
      if (code !== null) await tx.update(formularyMedicines).set({ code }).where(eq(formularyMedicines.id, m.medicineId));
      return m.medicineId;
    };
    const dolo = await med("Dolo (paracetamol) 650 mg oral tablet", "Oral tablet", "650 mg/", [paraId]);
    const pacimol = await med("Pacimol (paracetamol) 650 mg oral tablet", "Oral tablet", "650 mg/", [paraId]);
    const augmentin = await med("Augmentin DUO (amoxicillin and clavulanate potassium) 500 mg + 125 mg oral tablet", "Oral tablet", "500 mg/", [amox, clav], "H");
    const pan = await med("Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", "40 mg/", [panto], "H");
    const mox = await med("Mox (amoxicillin) 500 mg oral capsule", "Oral capsule", "500 mg/", [amox], "H");
    const montairLc = await med("Montair LC (levocetirizine dihydrochloride and montelukast sodium) 5 mg + 10 mg oral tablet", "Oral tablet", "5 mg/", [levo, monte], "H");
    const genericAmox200 = await med("Amoxicillin 200 mg oral tablet", "Oral tablet", "200 mg/", [amox], "H", "D4267");
    await med("Paracetamol 650 mg oral tablet", "Oral tablet", "650 mg/", [paraId], null, "D0650");
    const brandCalpol650 = await med("Calpol (paracetamol) 650 mg oral tablet", "Oral tablet", "650 mg/", [paraId]);
    const mk = async (code: string, medicineId: string): Promise<string> => {
      const { itemId } = await registerItem(tx, HEAD, {
        code, name: code, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: 500,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, a, itemId);
      return itemId;
    };
    return {
      dolo, pacimol, augmentin, pan, mox, montairLc, genericAmox200, brandCalpol650,
      item: {
        dolo: await mk("DOLO650", dolo), pacimol: await mk("PACIMOL650", pacimol), augmentin: await mk("AUGMENTIND500", augmentin),
        pan: await mk("PAN40", pan), mox: await mk("MOX500", mox), montairLc: await mk("MONTAIRLC5", montairLc),
      },
    };
  });
}

describe("the words the doctor wrote are read as a composition", () => {
  it("amounts per unit and per mL, the way the catalogue and the doctor spell them", () => {
    expect(amountsIn("650mg")).toEqual([{ mg: 650, per: "unit" }]);
    expect(amountsIn("500 mg + 125 mg oral tablet")).toEqual([{ mg: 500, per: "unit" }, { mg: 125, per: "unit" }]);
    expect(amountsIn("250/5 mg/ml")).toEqual([{ mg: 50, per: "ml" }]);
    expect(amountsIn("250 mg/5 mL oral suspension")).toEqual([{ mg: 50, per: "ml" }]);
    expect(amountsIn("500 mcg/5 ml")).toEqual([{ mg: 0.1, per: "ml" }]);
  });
  it("a moiety's two spellings share a key; a different moiety does not", () => {
    expect(moietyKey("clavulanate potassium")).toBe("clavulanic acid");
    expect(moietyKey("montelukast sodium")).toBe("montelukast");
    expect(moietyKey("levocetirizine dihydrochloride")).toBe("levocetirizine");
    expect(moietyKey("calcium carbonate")).toBe("calcium carbonate");
  });
  it("production's five lines", () => {
    expect(parseDrugText("Paracetamol Tablets 650mg")).toMatchObject({ names: ["paracetamol"], amounts: [{ mg: 650, per: "unit" }], sum: false, formWord: "tablet" });
    expect(parseDrugText("Amoxicillin and Clavulanic Acid 625mg")).toMatchObject({ names: ["amoxicillin", "clavulanic acid"], amounts: [{ mg: 625 }], sum: true });
    expect(parseDrugText("Levocetirizine 5mg + Ambroxol 60mg")).toMatchObject({ names: ["levocetirizine", "ambroxol"], amounts: [{ mg: 5 }, { mg: 60 }], sum: false });
    expect(parseDrugText("Pantoprazole 40mg")).toMatchObject({ names: ["pantoprazole"], amounts: [{ mg: 40 }], formWord: null });
    expect(parseDrugText("Amoxicillin 200 mg oral tablet")).toMatchObject({ names: ["amoxicillin"], amounts: [{ mg: 200 }], formWord: "tablet" });
    expect(parseDrugText("Paracetamol")).toBeNull(); // no strength — nothing to match against
  });
});

describe("a generic prescription opens already matched to the stocked brand (2026-09-23)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let shelf: Shelf;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    shelf = await prodShelf(db, fx);
    for (const [itemId, batchNo] of [
      [shelf.item.dolo, "DOLO-A"], [shelf.item.augmentin, "AUG-A"], [shelf.item.mox, "MOX-A"], [shelf.item.montairLc, "MLC-A"],
    ] as const) await stockIn(db, fx, { itemId, batchNo, qtyBase: 100 });
  });
  afterEach(() => { fx.unregister(); });

  async function queued(lines: Parameters<typeof issueRx>[2]): Promise<string> {
    const { issued } = await issueRx(db, fx, lines);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error(`expected a dispense, got ${JSON.stringify(r)}`);
    return r.dispense.id;
  }
  const PROD_LINES = (): Parameters<typeof issueRx>[2] => [
    line({ drug: "Paracetamol Tablets 650mg" }),
    line({ drug: "Amoxicillin and Clavulanic Acid 625mg" }),
    line({ drug: "Levocetirizine 5mg + Ambroxol 60mg" }),
    line({ drug: "Pantoprazole 40mg" }),
    line({ drug: "Amoxicillin 200 mg oral tablet", medicineId: shelf.genericAmox200 }),
  ];

  it("production's five lines: three open matched, priced and batched; the two the shelf cannot fill stay to be chosen", async () => {
    await stockIn(db, fx, { itemId: shelf.item.pan, batchNo: "PAN-A", qtyBase: 100 });
    const id = await queued(PROD_LINES());
    const v = await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    const codes = v.lines.map((l) => l.item?.code ?? null);
    expect(codes).toEqual(["DOLO650", "AUGMENTIND500", null, "PAN40", null]);
    for (const i of [0, 1, 3]) {
      expect(v.lines[i]).toMatchObject({ matchedBy: "salt", substitutionType: "resolved", saleable: true, orderedMedicine: null });
      expect(v.lines[i]!.quote).not.toBeNull();
      expect(v.lines[i]!.batches.length).toBeGreaterThan(0);
    }
    // levocetirizine 5 + ambroxol 60 tablet: Montair LC has levocetirizine but not ambroxol — no match
    expect(v.lines[2]).toMatchObject({ matchedBy: null, dispensedMedicine: null, item: null });
    // the generic amoxicillin 200 tablet: Mox 500 capsule is amoxicillin at another strength and form — no match
    expect(v.lines[4]).toMatchObject({ matchedBy: null, orderedMedicine: { id: shelf.genericAmox200 }, item: null });
    // Augmentin is Schedule H: the matched line makes the ticket scheduled, as a chosen one would
    expect((await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id)))[0]!.scheduled).toBe(true);
    // the rule is on the record, named, on whose claim
    const matched = await db.select().from(events).where(eq(events.name, "dispense.line_matched"));
    expect(matched.map((e) => ({ actor: e.actorId, ...(e.payload as object) }))).toEqual([
      expect.objectContaining({ actor: "pharmacy-match", lineIdx: 0, dispensedMedicineId: shelf.dolo, orderedMedicineId: null, rule: "salt", onClaimOf: fx.pharmacist.id }),
      expect.objectContaining({ lineIdx: 1, dispensedMedicineId: shelf.augmentin }),
      expect.objectContaining({ lineIdx: 3, dispensedMedicineId: shelf.pan }),
    ]);
  });

  it("the waiting row already counts a matchable line as on the shelf, and one it cannot fill as short", async () => {
    await queued(PROD_LINES());
    const [row] = await listQueue(db, fx.pharmacist.actor, { serviceDate: "2026-08-17" }, MON2);
    // Dolo and Augmentin are stocked; Pan is matched but has no stock yet; the other two cannot be placed
    expect(row!.shelf).toMatchObject({ lines: 5, onShelf: 2, short: ["Pantoprazole 40mg"], unplaceable: 1, notStocked: ["Amoxicillin 200 mg oral tablet"] });
  });

  it("an ordered GENERIC the shelf stocks a brand of is matched; a named BRAND the shelf lacks is never swapped", async () => {
    await withTx(db, async (tx) => {
      const amoxId = (await tx.select({ id: formularySalts.id }).from(formularySalts).where(eq(formularySalts.name, "amoxicillin")))[0]!.id;
      const g = await addMedicine(tx, fx.pharmacist.actor, { brandName: "Amoxicillin 500 mg oral capsule", form: "Oral capsule", routeClass: "systemic", strengthLabel: "500 mg/", scheduleFlag: "H", salts: [{ saltId: amoxId, strength: "500 mg/" }] });
      await tx.update(formularyMedicines).set({ code: "D0500" }).where(eq(formularyMedicines.id, g.medicineId));
    });
    const [generic] = await db.select({ id: formularyMedicines.id }).from(formularyMedicines).where(eq(formularyMedicines.code, "D0500"));
    const id = await queued([
      line({ drug: "Amoxicillin 500 mg oral capsule", medicineId: generic!.id }),
      line({ drug: "Calpol 650", medicineId: shelf.brandCalpol650 }), // the doctor named a brand the shelf does not carry
      line({ drug: "Dolo 650" }), // words naming no catalogue product and no strength unit
    ]);
    const v = await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    expect(v.lines[0]).toMatchObject({ matchedBy: "salt", item: { code: "MOX500" }, orderedMedicine: { id: generic!.id }, dispensedMedicine: { id: shelf.mox } });
    expect(v.lines[1]).toMatchObject({ matchedBy: null, item: null, dispensedMedicine: { id: shelf.brandCalpol650 }, substitutionType: "none" });
    expect(v.lines[2]).toMatchObject({ matchedBy: null, item: null });
  });

  it("several brands of one composition: the one with stock, then the batch that expires first, then the lowest MRP", async () => {
    // Pacimol has no stock yet: Dolo is the only one that can be filled
    let v = await claimDispense(db, fx.pharmacist.actor, { dispenseId: await queued([line({ drug: "Paracetamol 650mg tablet" })]), door: "rx_qr" }, MON2);
    expect(v.lines[0]!.item?.code).toBe("DOLO650");

    // Pacimol's batch expires first — it goes first (FEFO), whatever its price
    await stockIn(db, fx, { itemId: shelf.item.pacimol, batchNo: "PAC-A", qtyBase: 50, expiryDate: "2027-01-31", mrpPaise: 30000 });
    v = await claimDispense(db, fx.pharmacist.actor, { dispenseId: await queued([line({ drug: "Paracetamol 650mg tablet" })]), door: "rx_qr" }, MON2);
    expect(v.lines[0]!.item?.code).toBe("PACIMOL650");
  });

  it("same expiry: the lower MRP per tablet wins", async () => {
    await stockIn(db, fx, { itemId: shelf.item.pacimol, batchNo: "PAC-A", qtyBase: 50, expiryDate: "2027-06-30", mrpPaise: 3000 });
    const v = await claimDispense(db, fx.pharmacist.actor, { dispenseId: await queued([line({ drug: "Paracetamol 650mg tablet" })]), door: "rx_qr" }, MON2);
    expect(v.lines[0]!.item?.code).toBe("PACIMOL650"); // ₹30 a strip against Dolo's ₹120
  });

  it("the books run on the matched brand exactly as on a chosen one: a paracetamol allergy blocks it before and at the check", async () => {
    const id = await queued([line({ drug: "Paracetamol Tablets 650mg" })]);
    await addAllergy(db, fx.patient.id, "Paracetamol"); // recorded after the issue: the doctor could not have seen it
    const v = await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    expect(v.lines[0]).toMatchObject({ matchedBy: "salt", item: { code: "DOLO650" } });
    expect((await precheckTicket(db, fx.pharmacist.actor, id, MON2)).lines[0]).toMatchObject({ verdict: "blocked", blocks: [expect.objectContaining({ book: "allergy" })] });
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));
  });

  it("a ticket already open is matched when its holder opens it — once, and never by anyone else", async () => {
    // claimed while the shelf had no Pan in stock: the line was laid unplaced, as production's were
    const id = await queued([line({ drug: "Pantoprazole 40mg" })]);
    const before = await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    expect(before.lines[0]).toMatchObject({ matchedBy: null, item: null });
    await stockIn(db, fx, { itemId: shelf.item.pan, batchNo: "PAN-B", qtyBase: 60 });

    expect(await matchOpenLines(db, fx.incharge.actor, id, MON2)).toBe(0); // not the holder: nothing written
    expect(await matchOpenLines(db, fx.pharmacist.actor, id, MON2)).toBe(1);
    expect(await matchOpenLines(db, fx.pharmacist.actor, id, MON2)).toBe(0); // idempotent
    expect((await getDispense(db, fx.pharmacist.actor, id)).lines[0]).toMatchObject({ matchedBy: "salt", item: { code: "PAN40" } });
    expect(await db.select().from(events).where(eq(events.name, "dispense.line_matched"))).toHaveLength(1);
  });
});
