import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyGenerics, formularyMonographs, formularyRenalDoses } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { getMonograph, renalDoseFor, reviewMonograph, saveMonograph, searchGenerics } from "./monographs";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { MonographInput } from "./monographs";

const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const PHYSICIAN: Actor = { type: "user", id: "01HPHYSICIAN00000000000001" };
const SCTID = "1201952000";

/** The owner's own example (the Drug Information Service specification v1.25, Herpex 800 DT), cut to what the tests read. */
const ACICLOVIR: MonographInput = {
  genericSctid: SCTID,
  sourceVersion: "1.25",
  patient: {
    patient_summary: { what_it_is: "An antiviral prescription medicine containing Aciclovir (800 mg)." },
    plain_language_faqs: [{ intent: "how_to_take", answer_en: "Dissolve 1 tablet in about 25 ml of water.", answer_hi: "1 गोली को 25 मिली पानी में घोलें।" }],
  },
  prescriber: { who_atc_code: "J05AB01", approved_indications: [{ icd10_code: "B02.9", standard_adult_regimen: "800 mg 5 times daily for 7 to 10 days" }] },
  nursing: { enteral_tube_administration: { can_crush_or_disperse: true } },
  affordability: { pmbjp_drug_code: "PMBJP-AV08", jan_aushadhi_mrp_per_strip_of_5: 42.5 },
  renalDoses: [
    { crclMin: 25, crclMax: null, dose: "800 mg every 4 hours (5 times daily while awake)", severity: "normal" },
    { crclMin: 10, crclMax: 25, dose: "800 mg every 8 hours", severity: "reduce" },
    { crclMin: null, crclMax: 10, dose: "800 mg every 12 hours", severity: "reduce" },
  ],
};

describe("the drug monograph: written as a draft, shown only once a second person has reviewed it", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let genericId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    genericId = newId();
    await db.insert(formularyGenerics).values({
      id: genericId, sctid: SCTID, name: "Acyclovir 800 mg dispersible oral tablet", nameNormalized: "acyclovir 800 mg dispersible oral tablet",
      doseForm: "dispersible oral tablet", routeOfAdministration: "oral", source: "nrces-2026-09",
      createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id,
    });
  });

  const save = (input: MonographInput = ACICLOVIR, actor: Actor = PHARMACIST) => withTx(db, (tx) => saveMonograph(tx, actor, input));
  const review = (monographId: string, actor: Actor) => withTx(db, (tx) => reviewMonograph(tx, actor, monographId));
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof FormularyError) return e.code; throw e; }
    return "did not refuse";
  };

  it("a saved monograph is a draft: nothing reads it, and no renal band answers from it", async () => {
    const { monographId } = await save();
    expect(await getMonograph(db, SCTID)).toBeUndefined();
    expect(await renalDoseFor(db, genericId, 18)).toBeNull();
    const draft = await getMonograph(db, SCTID, { includeDraft: true });
    expect(draft).toMatchObject({
      id: monographId, genericId, status: "draft", sourceVersion: "1.25", reviewedBy: null, reviewedAt: null,
      patient: ACICLOVIR.patient, prescriber: ACICLOVIR.prescriber, nursing: ACICLOVIR.nursing, affordability: ACICLOVIR.affordability,
    });
    expect(draft?.renalDoses.map((b) => [b.crclMin, b.crclMax, b.severity])).toEqual([[null, 10, "reduce"], [10, 25, "reduce"], [25, null, "normal"]]);
    const saved = await db.select().from(events).where(eq(events.name, "monograph.saved"));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.payload).toMatchObject({ monographId, genericId, sections: ["patient", "prescriber", "nursing", "affordability"], renalBands: 3 });
  });

  it("the person who wrote it cannot review it; a second person can, once; then it is read and the renal band answers by clearance", async () => {
    const { monographId } = await save();
    expect(await code(review(monographId, PHARMACIST))).toBe("monograph_same_actor");
    expect(await getMonograph(db, SCTID)).toBeUndefined();

    await review(monographId, PHYSICIAN);
    const shown = await getMonograph(db, SCTID);
    expect(shown).toMatchObject({ status: "reviewed", reviewedBy: PHYSICIAN.id });
    expect(shown?.reviewedAt).toBeInstanceOf(Date);
    expect(await code(review(monographId, PHYSICIAN))).toBe("monograph_already_reviewed");
    expect(await code(review(newId(), PHYSICIAN))).toBe("unknown_monograph");

    // The lower bound is inside its band and the upper bound is not: 10 reads the middle band, 25 the normal one.
    expect((await renalDoseFor(db, genericId, 18))?.dose).toBe("800 mg every 8 hours");
    expect((await renalDoseFor(db, genericId, 10))?.dose).toBe("800 mg every 8 hours");
    expect((await renalDoseFor(db, genericId, 9))?.dose).toBe("800 mg every 12 hours");
    expect((await renalDoseFor(db, genericId, 25))?.severity).toBe("normal");
    expect((await renalDoseFor(db, genericId, 90))?.severity).toBe("normal");
    expect(await db.select().from(events).where(eq(events.name, "monograph.reviewed"))).toHaveLength(1);
  });

  it("an edit after review is a new draft: the review is gone, the text is hidden again, and the bands are replaced whole", async () => {
    const { monographId } = await save();
    await review(monographId, PHYSICIAN);
    const again = await save({ ...ACICLOVIR, nursing: null, renalDoses: [{ crclMin: null, crclMax: 30, dose: "800 mg every 12 hours", severity: "reduce" }] }, PHYSICIAN);
    expect(again.monographId).toBe(monographId);
    expect(await getMonograph(db, SCTID)).toBeUndefined();
    expect(await renalDoseFor(db, genericId, 18)).toBeNull();
    const draft = await getMonograph(db, SCTID, { includeDraft: true });
    expect(draft).toMatchObject({ status: "draft", reviewedBy: null, reviewedAt: null, nursing: null });
    expect(draft?.renalDoses).toHaveLength(1);
    // The physician wrote this draft, so now the pharmacist is the second person.
    expect(await code(review(monographId, PHYSICIAN))).toBe("monograph_same_actor");
    await review(monographId, PHARMACIST);
    expect((await renalDoseFor(db, genericId, 18))?.dose).toBe("800 mg every 12 hours");
    expect(await renalDoseFor(db, genericId, 45)).toBeNull();
  });

  it("refuses a generic the formulary does not hold, bands that overlap, a band with no bound, and an inverted band", async () => {
    expect(await code(save({ ...ACICLOVIR, genericSctid: "999" }))).toBe("unknown_generic");
    const bands = (renalDoses: MonographInput["renalDoses"]) => code(save({ ...ACICLOVIR, renalDoses }));
    expect(await bands([{ crclMin: 10, crclMax: 30, dose: "a", severity: "reduce" }, { crclMin: 25, crclMax: null, dose: "b", severity: "normal" }])).toBe("invalid_monograph");
    expect(await bands([{ crclMin: null, crclMax: null, dose: "a", severity: "normal" }])).toBe("invalid_monograph");
    expect(await bands([{ crclMin: 30, crclMax: 10, dose: "a", severity: "reduce" }])).toBe("invalid_monograph");
    expect(await bands([{ crclMin: null, crclMax: 10, dose: "a", severity: "avoid" }, { crclMin: null, crclMax: 5, dose: "b", severity: "avoid" }])).toBe("invalid_monograph");
    expect(await db.select().from(formularyMonographs)).toHaveLength(0);
    expect(await db.select().from(formularyRenalDoses)).toHaveLength(0);
  });

  it("the curation door finds a generic by any part of its name and says where its monograph stands: none, draft or reviewed", async () => {
    const other = newId();
    await db.insert(formularyGenerics).values([
      { id: other, sctid: "777000111", name: "Valacyclovir 500 mg oral tablet", nameNormalized: "valacyclovir 500 mg oral tablet", doseForm: "oral tablet", routeOfAdministration: "oral", source: "nrces-2026-09", createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id },
      { id: newId(), sctid: "777000222", name: "Acyclovir 5% cream (withdrawn)", nameNormalized: "acyclovir 5% cream withdrawn", doseForm: "cream", routeOfAdministration: "topical", source: "nrces-2026-09", active: false, createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id },
    ]);
    const found = async (q: string) => (await searchGenerics(db, q)).map((h) => [h.sctid, h.monographStatus]);
    // A name that STARTS with what was typed comes first; an inactive generic is not offered; one letter asks nothing.
    expect(await found("Acyclo")).toEqual([[SCTID, "none"], ["777000111", "none"]]);
    expect(await found("a")).toEqual([]);
    expect(await found("100%")).toEqual([]);
    const { monographId } = await save();
    expect(await found("acyclovir 800")).toEqual([[SCTID, "draft"]]);
    await review(monographId, PHYSICIAN);
    expect(await searchGenerics(db, "ACYCLOVIR 800")).toEqual([{ id: genericId, sctid: SCTID, name: "Acyclovir 800 mg dispersible oral tablet", doseForm: "dispersible oral tablet", monographStatus: "reviewed" }]);
    expect(await searchGenerics(db, "cyclovir", 1)).toHaveLength(1);
  });

  it("the database itself refuses a reviewed row with no reviewer, and a second monograph for one generic", async () => {
    const row = { genericId, sourceVersion: "1.25", createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id };
    await expect(db.insert(formularyMonographs).values({ ...row, id: newId(), status: "reviewed" })).rejects.toThrow();
    await expect(db.execute(sql`insert into formulary_monographs (id, generic_id, source_version, status, created_by, updated_by) values (${newId()}, ${genericId}, '1.25', 'published', ${PHARMACIST.id}, ${PHARMACIST.id})`)).rejects.toThrow();
    await db.insert(formularyMonographs).values({ ...row, id: newId() });
    await expect(db.insert(formularyMonographs).values({ ...row, id: newId() })).rejects.toThrow();
  });
});
