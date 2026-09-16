import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { formularySalts, pharmacyRegH1 } from "../../kernel/db/schema";
import { addMedicine } from "../formulary";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { labelFor } from "./label";
import { pickDispense } from "./pick";
import { getDispense } from "./queue";
import { shelfByMedicine } from "./shelf";
import { alternativesFor, verifyDispense } from "./verify";
import type { Db } from "../../kernel/db/client";
import type { RxLine } from "../opd";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";

/**
 * ═══ THE PHARMACY OVER A NATIONAL-SCALE CATALOGUE: THE CALL SITES, NOT THE HELPERS ═══
 *
 * WHY THIS SUITE EXISTS. `formulary/catalogue-scale.test.ts` pins that the formulary's own reads
 * survive a catalogue past the Int16 bind ceiling, and `reads.ts`/`equivalence.ts` carry their own
 * suites. None of that proves the thing the pharmacy actually depends on: that the COUNTER asks for
 * the medicines a dispense names rather than for every medicine in the country. A suite that
 * exercised only the helpers would stay green for ever while `queue.ts` went on handing them every
 * id in the catalogue — which is exactly the code that shipped until `b60032a4`.
 *
 * So this seeds the catalogue past the ceiling and then drives the REAL counter end to end on top
 * of it: claim, the dispense view, the substitution dropdown, the verify gate, the label, the
 * hand-over register. Every one of those sites used to reach the catalogue through
 * `listMedicines`, whose composition read is an `inArray` over every id it just selected.
 *
 * MEASURED against THIS suite's own seeded database (70,010 medicines), read-only, by issuing that
 * statement shape by hand:
 *
 *     n = 65,535  ->  OK
 *     n = 65,536  ->  08P01  bind message supplies 0 parameters, but prepared statement ""
 *                           requires 65536
 *     n = 70,010  ->  08P01  bind message has 4474 parameter formats but 0 parameters
 *                           (70,010 mod 65,536 = 4,474 — the wrap, arithmetically)
 *
 * That is what every case below does to the code before `b60032a4`, and it is each case's reason to
 * exist. They are listed one per CALL SITE rather than folded together because each site is a
 * separate promise to a separate screen, and a fix that closed only the first would leave the rest
 * throwing.
 *
 * ═══ THE SECOND PROPERTY, WHICH ONLY EXISTS NOW THAT THE READS ARE BOUNDED ═══
 *
 * An unbounded read hid INCOMPLETENESS by construction: a caller that forgot to ask about a
 * medicine still found it, because the map held every medicine there was. A bounded read makes the
 * asked-for set part of the answer — forget the ordered brand and the screen prints nothing where a
 * brand should be. Several cases below therefore assert that BOTH sides of a substitution are
 * named, which is a property no test could have had before the ids became explicit.
 *
 * ═══ WHY THE SEED IS IN `beforeAll` AND THERE IS NO `beforeEach` TRUNCATE ═══
 *
 * The house idiom is `truncateAll` per test, and it cannot be used here: it would delete the very
 * catalogue this suite is about, and re-seeding 70,000 rows plus a full `seedPharmacyBase` seven
 * times would cost more than the rest of the pharmacy's suites put together. The fixture is
 * therefore built ONCE and every case takes a FRESH ENCOUNTER out of it — a new visit in the
 * doctor's own session, twenty minutes after the last, which is what a real counter morning is.
 * Nothing a case does to its own dispense can be seen by another; the two pieces of shared mutable
 * state are (a) the stock balances, which only the last two cases touch, and (b) the wall of
 * decoys, which is append-only. Where a case asserts an exact `available` it says so out loud.
 */
const SCALE = 70_000;

/**
 * One short of 65,536 is not a margin, it IS the boundary: 65,535 passes and 65,536 throws, so a
 * suite seeded at 60,000 would be green over the defect this file was written for.
 */
const BIND_CEILING = 65_535;

/**
 * Real paracetamol 500 mg tablet brands that this hospital does NOT stock — Micro Labs, Ipca,
 * Cipla, Themis, East India Pharmaceutical. They are generic equivalents of Crocin 500 in every
 * sense `equivalence.ts` tests for: same moiety, same strength label, same form, same route.
 *
 * They are the decoys that matter. The 70,000 rows below are composition-less filler whose only job
 * is to push the catalogue past the wire's ceiling; these five are the rows that would appear in a
 * substitution dropdown the moment anyone widened its universe from THE SHELF back to THE
 * CATALOGUE. The counter may only offer what it can hand over, and it cannot hand over a brand it
 * has never bought.
 */
const UNSTOCKED_PARACETAMOL = ["Dolo 500", "Pacimol 500", "Paracip 500", "Metacin 500", "Pyrigesic 500"] as const;

/** 5 from `seedPharmacyBase` + the 5 real unstocked brands above. */
const CURATED = 10;

/**
 * The wall of decoys, in ONE statement rather than 70,000 round trips (the shape
 * `formulary/catalogue-scale.test.ts` established, and the reason this suite costs seconds rather
 * than minutes). They carry no composition and no strength label, so they are excluded from every
 * equivalence question twice over — by the `count(want) > 0` clause and by the strength equality —
 * and they are invented names, which is the one place the house's real-pharmacology rule does not
 * bite: no assertion in this file depends on what they ARE, only on how many of them there are.
 */
async function seedDecoyCatalogue(db: Db, n: number): Promise<void> {
  await db.execute(sql`
    insert into formulary_medicines (id, brand_name, form, route_class, salt_rank, active, created_by, updated_by)
    select 'PHSCALE' || lpad(g::text, 12, '0'), 'Pharmacy Scale Decoy ' || lpad(g::text, 12, '0'),
           'tablet', 'systemic', 0, true, 'bounded-reads-test', 'bounded-reads-test'
      from generate_series(1, ${n}) g
  `);
}

describe("the pharmacy counter over a national-scale catalogue", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let dolo: string;
  let crocinBatch: string;
  let calpolBatch: string;
  let azeeBatch: string;

  /** Each case opens its visit twenty minutes after the last one's, inside the 09:00–13:00 template. */
  let slot = MON;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    crocinBatch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-12-31", qtyBase: 100 });
    calpolBatch = await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CAL-1", expiryDate: "2027-08-31", qtyBase: 100 });
    azeeBatch = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 20 });

    const [paracetamol] = await db.select().from(formularySalts).where(eq(formularySalts.name, "Paracetamol"));
    if (paracetamol === undefined) throw new Error("the pharmacy fixture no longer seeds paracetamol");
    const ids = await withTx(db, async (tx) => {
      const out: string[] = [];
      for (const brandName of UNSTOCKED_PARACETAMOL) {
        const { medicineId } = await addMedicine(tx, fx.pharmacist.actor, {
          brandName, form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "OTC",
          salts: [{ saltId: paracetamol.id, strength: "500 mg" }],
        });
        out.push(medicineId);
      }
      return out;
    });
    dolo = ids[0]!;

    await seedDecoyCatalogue(db, SCALE);
  }, 120_000);

  afterAll(async () => { fx.unregister(); await teardown(); });

  /** A fresh visit, prescription and CLAIMED dispense — the state every case below starts from. */
  async function claimed(lines: RxLine[]): Promise<{ id: string; at: Date }> {
    const visitAt = slot;
    slot = new Date(slot.getTime() + 20 * 60_000);
    const at = new Date(visitAt.getTime() + 5 * 60_000); // the patient reaches the counter
    const { issued } = await issueRx(db, fx, lines, { at: visitAt });
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, at);
    if (found.kind !== "dispense") throw new Error(`expected a dispense, got ${JSON.stringify(found)}`);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: found.dispense.id, door: "rx_qr" }, at);
    return { id: found.dispense.id, at };
  }

  /**
   * THE FIXTURE GUARD, and it is not ceremony: every case below is a claim about behaviour AT
   * SCALE, and each one of them would pass trivially against a 10-row catalogue. If this case is
   * red the rest of the suite is vacuous rather than green.
   *
   * It pins the two halves that must be true together. The catalogue is past the wire's ceiling —
   * and the SHELF, which is what the counter is allowed to reason about, has not moved: three drug
   * items bridged to active sale items, the same three the small-scale suites use. The whole bound
   * in this module is that second number staying small while the first one grows.
   */
  it("the catalogue is past the Int16 bind ceiling while the shelf the counter sells from is still three items", async () => {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from formulary_medicines`);
    const seeded = Number(r.rows[0]?.n ?? 0);
    expect(seeded).toBe(SCALE + CURATED);
    expect(seeded).toBeGreaterThan(BIND_CEILING);

    const shelf = await shelfByMedicine(db);
    expect([...shelf.keys()].sort()).toEqual([fx.med.crocin, fx.med.calpol, fx.med.azithro].sort());
    expect([...shelf.values()].map((e) => e.item.code).sort()).toEqual(["AZEE500", "CALP500", "CROC500"]);
  });

  /**
   * CLAIM — `claim.ts`. The screen the pharmacist sees the instant they scan: every line laid out
   * with the brand it resolved to, its schedule and its stocked item. Two id sets meet here, the
   * lines the doctor keyed BY ID and the ones resolved from free text, and the claim must ask about
   * both — so the Rx carries one of each. The free-text line also drives `resolveDrugTexts` across
   * the whole seeded catalogue, which is how a real Indian Rx arrives.
   */
  it("the claim screen names the brand on every line — one keyed by id, one resolved from free text", async () => {
    const { id, at } = await claimed([
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
      line({ drug: "Crocin 500" }),
    ]);
    const d = await getDispense(db, fx.pharmacist.actor, id, at);
    expect(d.status).toBe("claimed");
    expect(d.lines.map((l) => [l.dispensedMedicine?.brandName ?? null, l.scheduleFlag, l.substitutionType, l.item?.code ?? null])).toEqual([
      ["Azee 500", "H1", "none", "AZEE500"],
      ["Crocin 500", "OTC", "resolved", "CROC500"],
    ]);
    expect(d.lines[1]!.dispensedMedicine).toMatchObject({ id: fx.med.crocin, strengthLabel: "500 mg", form: "tablet" });
  });

  /**
   * THE SUBSTITUTION DROPDOWN — `verify.ts:alternativesFor`. The answer at 70,010 medicines must be
   * the answer at 5, and the exact array is asserted rather than its length: "returns 1
   * alternative" stays green when it returns the WRONG one, which is the failure mode that matters
   * when the list is being computed against a hundred thousand rows.
   *
   * Five real paracetamol 500 mg brands sit in this catalogue and are generic equivalents of Crocin
   * by every clause of the predicate. None may be offered, because none is on the shelf: an offer
   * this counter cannot fill is worse than no offer, and it is precisely what a universe widened
   * from the shelf back to the catalogue would produce.
   *
   * `available: 100` is the whole Calpol batch. It is exact on purpose — the dropdown's promise IS
   * the pick's answer — and it is read before any case below reserves a Calpol tablet.
   */
  it("the dropdown offers the one generic this counter stocks, never the five it does not", async () => {
    const { id } = await claimed([
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
    ]);
    expect(await alternativesFor(db, id, 0)).toEqual([{
      medicineId: fx.med.calpol, brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet",
      itemId: fx.item.calpol, itemCode: "CALP500", available: 100,
    }]);
    // Azithromycin has no second brand on this shelf, and 70,000 decoys do not invent one.
    expect(await alternativesFor(db, id, 1)).toEqual([]);
  });

  /**
   * THE DISPENSE VIEW — `queue.ts:getDispense`, the return value of EVERY pharmacy mutation and the
   * single hottest read in the module. It is asserted after a substitution because that is where
   * the view names TWO medicines on one line: the brand the doctor wrote and the brand that will
   * leave the window. Both ids must be in the set the view asks about, and until the read was
   * bounded no test could tell — a map holding the whole catalogue answers for ids nobody asked for.
   */
  it("the dispense view names both brands on a substituted line — what the doctor wrote and what leaves", async () => {
    const { id, at } = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 15, dispensedMedicineId: fx.med.calpol, patientConsent: true }],
    }, at);
    expect(v.status).toBe("verified");

    const d = await getDispense(db, fx.pharmacist.actor, id, at);
    expect(d.lines[0]!.orderedMedicine).toEqual({ id: fx.med.crocin, brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet" });
    expect(d.lines[0]!.dispensedMedicine).toEqual({ id: fx.med.calpol, brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" });
    expect(d.lines[0]).toMatchObject({ substitutionType: "generic", qtyBase: 15, item: { code: "CALP500" } });
  });

  /**
   * THE VERIFY GATE — `verify.ts:verifyDispense`, which asks `isEquivalentMedicine` about the
   * substitute the pharmacist typed. Three answers, all three at scale:
   *
   *   Brufen 400   — a different moiety at a different strength: `substitution_not_allowed`. A
   *                  different medicine is a new prescription, and that is the doctor's.
   *   Dolo 500     — a TRUE generic equivalent that this hospital does not stock. The equality
   *                  passes and the shelf is what refuses it, by a different code
   *                  (`unknown_sale_item`), which is the honest thing to tell a pharmacist: not
   *                  "wrong medicine" but "not on our shelf". Nothing but a catalogue bigger than
   *                  the shelf can produce this case, which is why it lives in this file.
   *   Calpol 500   — stocked and equivalent: it goes through.
   */
  it("the verify gate judges a substitute against the catalogue and the shelf, and says which one refused it", async () => {
    const { id, at } = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 15, dispensedMedicineId: fx.med.ibuprofen, patientConsent: true }],
    }, at)).rejects.toThrow(expect.objectContaining({ code: "substitution_not_allowed" }));

    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 15, dispensedMedicineId: dolo, patientConsent: true }],
    }, at)).rejects.toThrow(expect.objectContaining({ code: "unknown_sale_item" }));

    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 15, dispensedMedicineId: fx.med.calpol, patientConsent: true }],
    }, at);
    expect(v.lines[0]).toMatchObject({ substitutionType: "generic", dispensedMedicine: { id: fx.med.calpol } });
  });

  /**
   * THE LABEL — `label.ts:labelFor`, the paper the patient carries home and the only artefact in
   * this flow a patient ever reads. It names both brands for the same reason the view does: the
   * dispensed one at the top, the prescribed one as "substituted for", so the patient's own doctor
   * can see at the next visit what was actually swallowed.
   */
  it("the label prints the brand handed over and the brand it was substituted for", async () => {
    const { id, at } = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 20, dispensedMedicineId: fx.med.calpol, patientConsent: true }],
    }, at);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, new Date(at.getTime() + 5 * 60_000));

    const label = await labelFor(db, fx.pharmacist.actor, id);
    expect(label.patient.uhid).toBe(fx.patient.uhid);
    expect(label.lines).toHaveLength(1);
    expect(label.lines[0]).toMatchObject({
      drug: "Calpol 500", strength: "500 mg", form: "tablet", qtyBase: 20, unit: "tablet", packs: "2 strip",
      batchNo: "CAL-1", expiryDate: "2027-08-31", substitutedFor: "Crocin 500", directions: "1 tab · TDS · 5 days",
    });
    // The substitution carried all the way through to the pick: the batch held is Calpol's own.
    expect((await getDispense(db, fx.pharmacist.actor, id, at)).lines[0]!.batchId).toBe(calpolBatch);
  });

  /**
   * HAND-OVER — `handover.ts:handOverDispense`, the irreversible act, and the one read in this
   * module with a statutory consumer: Rule 65(3)'s H1 register copies the DRUG NAME at write time,
   * and that name is built from the formulary row rather than from the prescription's free text.
   *
   * The doctor here writes molecules ("Azithromycin 500"), which is what NRCeS-era prescribing
   * looks like and what the formulary lane's own molecule search encourages. So the register's
   * `drug_name` and the Rx line's text are DIFFERENT STRINGS, and the assertion can tell which one
   * was written. A hand-over that could not read the catalogue would either throw on the wire or
   * fall back to the doctor's text, and the register would record a molecule where the law wants
   * the brand, batch and quantity that left the window.
   */
  it("hand-over writes the H1 register from the formulary brand, not from the doctor's free text", async () => {
    const { id, at } = await claimed([
      line({ drug: "Paracetamol 500", medicineId: fx.med.crocin }),
      line({ drug: "Azithromycin 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
    ]);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }, { lineIdx: 1, qtyBase: 3 }] }, at);
    const picked = new Date(at.getTime() + 5 * 60_000);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, picked);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, picked);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, picked);

    const h = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "3210" } }, new Date(at.getTime() + 10 * 60_000));
    expect(h.status).toBe("handed_over");
    expect(h.lines.map((l) => l.dispensedMedicine?.brandName ?? null)).toEqual(["Crocin 500", "Azee 500"]);

    const reg = await db.select().from(pharmacyRegH1);
    expect(reg).toHaveLength(1); // the H1 line only — paracetamol is OTC and carries no register row
    expect(reg[0]).toMatchObject({ drugName: "Azee 500 500 mg tablet", batchNo: "AZ-1", qtyBase: 3, unit: "tablet", medicineId: fx.med.azithro });
    expect(h.lines.map((l) => l.batchId)).toEqual([crocinBatch, azeeBatch]);
  });
});
