import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { formularyGenerics, formularyMedicines } from "../../kernel/db/schema";
import { counsellingByMedicine, counsellingOf, linkMedicinesToGenerics, monographForMedicine } from "./generic-link";
import { reviewMonograph, saveMonograph } from "./monographs";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const PHYSICIAN: Actor = { type: "user", id: "01HPHYSICIAN00000000000001" };
const ACV = "1201952000";
const VAL = "777000111";

describe("a product knows its generic: the link the bundle carries and the catalogue never stored (owner 2026-10-02)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const by = { createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id };
  const generic = async (sctid: string, name: string): Promise<string> => {
    const id = newId();
    await db.insert(formularyGenerics).values({ id, sctid, name, nameNormalized: name.toLowerCase(), doseForm: "oral tablet", routeOfAdministration: "oral", source: "nrces-2026-09", ...by });
    return id;
  };
  const medicine = async (brandName: string, sourceRef: string | null, genericSctid: string | null = null): Promise<string> => {
    const id = newId();
    await db.insert(formularyMedicines).values({ id, brandName, form: "tablet", nameNormalized: brandName.toLowerCase(), sourceRef, genericSctid, ...by });
    return id;
  };
  const linkOf = async (id: string) => (await db.select({ g: formularyMedicines.genericSctid }).from(formularyMedicines).where(eq(formularyMedicines.id, id)))[0]?.g;
  const link = (pairs: { medicineSctid: string; genericSctid: string }[]) => withTx(db, (tx) => linkMedicinesToGenerics(tx, pairs));

  it("links a brand by its own SNOMED CT id and a generic's product row to itself; never overwrites a link, and counts what it could not place", async () => {
    await generic(ACV, "Acyclovir 800 mg dispersible oral tablet");
    await generic(VAL, "Valacyclovir 500 mg oral tablet");
    const herpex = await medicine("Herpex 800 DT", "B-HERPEX");
    const ownRow = await medicine("Acyclovir 800 mg dispersible oral tablet", ACV);
    const curated = await medicine("Valcivir 500", "B-VALCIVIR", VAL);
    const orphan = await medicine("Some Tonic", "B-TONIC");
    const handMade = await medicine("Hospital Mixture", null);

    const report = await link([
      { medicineSctid: "B-HERPEX", genericSctid: ACV },
      { medicineSctid: "B-VALCIVIR", genericSctid: ACV }, // already linked by a person: left alone
      { medicineSctid: "B-TONIC", genericSctid: "404404404" }, // the generic is not in the formulary
      { medicineSctid: "B-NOT-STOCKED", genericSctid: ACV }, // no such product row
    ]);
    expect(report).toEqual({ pairs: 4, linkedBrands: 1, linkedOwnRows: 1, unknownGeneric: 1 });
    expect(await linkOf(herpex)).toBe(ACV);
    expect(await linkOf(ownRow)).toBe(ACV);
    expect(await linkOf(curated)).toBe(VAL);
    expect(await linkOf(orphan)).toBeNull();
    expect(await linkOf(handMade)).toBeNull();

    // A second run finds nothing left to do.
    expect(await link([{ medicineSctid: "B-HERPEX", genericSctid: VAL }])).toEqual({ pairs: 1, linkedBrands: 0, linkedOwnRows: 0, unknownGeneric: 0 });
    expect(await linkOf(herpex)).toBe(ACV);
  });

  it("the counselling line is the patient section's own `counselling`, else its how-to-take answer, else nothing", () => {
    expect(counsellingOf({ counselling: { en: " Dissolve in 25 ml water. ", hi: "25 मिली पानी में घोलें।" }, plain_language_faqs: [{ intent: "how_to_take", answer_en: "ignored" }] }))
      .toEqual({ en: "Dissolve in 25 ml water.", hi: "25 मिली पानी में घोलें।" });
    expect(counsellingOf({ plain_language_faqs: [{ intent: "alcohol", answer_en: "Avoid." }, { intent: "how_to_take", answer_en: "With food." }] })).toEqual({ en: "With food.", hi: null });
    expect(counsellingOf({ counselling: { en: "   " } })).toBeNull();
    expect(counsellingOf({ counselling: "take it", plain_language_faqs: "none" })).toBeNull();
    expect(counsellingOf({ plain_language_faqs: [{ intent: "how_to_take", answer_en: 5 }] })).toBeNull();
    expect(counsellingOf(null)).toBeNull();
  });

  it("counselling for many products at once comes only from reviewed monographs of linked products", async () => {
    await generic(ACV, "Acyclovir 800 mg dispersible oral tablet");
    await generic(VAL, "Valacyclovir 500 mg oral tablet");
    const herpex = await medicine("Herpex 800 DT", "B-HERPEX", ACV);
    const valcivir = await medicine("Valcivir 500", "B-VALCIVIR", VAL);
    const tonic = await medicine("Some Tonic", "B-TONIC");
    const reviewed = await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, { genericSctid: ACV, sourceVersion: "1.25", patient: { counselling: { en: "Dissolve in 25 ml water." } } }));
    await withTx(db, (tx) => reviewMonograph(tx, PHYSICIAN, reviewed.monographId));
    await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, { genericSctid: VAL, sourceVersion: "1.25", patient: { counselling: { en: "A draft nobody reviewed." } } }));
    expect(await counsellingByMedicine(db, [herpex, valcivir, tonic])).toEqual(new Map([[herpex, { en: "Dissolve in 25 ml water.", hi: null }]]));
    expect(await counsellingByMedicine(db, [])).toEqual(new Map());
  });

  it("a brand reads its generic's monograph only once that is reviewed; an unlinked product reads none", async () => {
    await generic(ACV, "Acyclovir 800 mg dispersible oral tablet");
    const herpex = await medicine("Herpex 800 DT", "B-HERPEX");
    const tonic = await medicine("Some Tonic", "B-TONIC");
    const { monographId } = await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, {
      genericSctid: ACV, sourceVersion: "1.25", patient: { counselling: "Dissolve in 25 ml water." },
      renalDoses: [{ crclMin: null, crclMax: 10, dose: "800 mg every 12 hours", severity: "reduce" }],
    }));
    await withTx(db, (tx) => reviewMonograph(tx, PHYSICIAN, monographId));
    expect(await monographForMedicine(db, herpex)).toBeUndefined(); // not linked yet

    await link([{ medicineSctid: "B-HERPEX", genericSctid: ACV }]);
    const read = await monographForMedicine(db, herpex);
    expect(read).toMatchObject({ id: monographId, status: "reviewed", patient: { counselling: "Dissolve in 25 ml water." } });
    expect(read?.renalDoses).toHaveLength(1);
    expect(await monographForMedicine(db, tonic)).toBeUndefined();
    expect(await monographForMedicine(db, newId())).toBeUndefined();

    // An edit makes it a draft again, and the brand stops reading it.
    await withTx(db, (tx) => saveMonograph(tx, PHYSICIAN, { genericSctid: ACV, sourceVersion: "1.26", patient: { counselling: "Changed." } }));
    expect(await monographForMedicine(db, herpex)).toBeUndefined();
  });
});
