import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { withTx } from "../../../kernel/db/client";
import { formularyCrkEntries, formularyGenerics, formularyMedicines } from "../../../kernel/db/schema";
import { registerItem } from "../../materials";
import { crkWorklist, signedCrkForGeneric } from "../crk-formulary";
import { CRK_BATCH_DEFAULT, CRK_BATCH_MAX, crkCostReport, runCrkDraftBatch, stockedGenericsToDraft } from "../crk-batch";
import { fetchOpenFdaSource, fetchPubchemSources } from "../crk-sources";
import { FormularyError } from "../errors";
import { addMedicine, addSalt } from "../masters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { CompleteInput, InferenceClient } from "../../../kernel/inference/types";
import type { DraftSourceInput } from "../crk-formulary";
import type { FetchLike } from "../crk-sources";

/**
 * Spec #883 (docs/specs/883-crk-formulary-drafting.md) — fetchers for public sources and the batch job that drafts the
 * stocked generics through the #618 drafter. The model only drafts; nothing the job writes is ever shown to a doctor.
 */

const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000883" };
const ON = "2026-10-23";

/** A fetch that answers from a table of URL fragments, and records every URL asked. */
function fakeFetch(table: [string, unknown][], asked: string[] = []): FetchLike {
  return async (url: string) => {
    asked.push(url);
    const hit = table.find(([frag]) => url.includes(frag));
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({ error: { code: "NOT_FOUND" } }) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
}

const LABEL_SINGLE = {
  set_id: "set-single-rx", effective_time: "20250310", id: "label-1",
  openfda: { generic_name: ["METFORMIN HYDROCHLORIDE"], brand_name: ["GLUCOPHAGE"], substance_name: ["METFORMIN HYDROCHLORIDE"], product_type: ["HUMAN PRESCRIPTION DRUG"] },
  indications_and_usage: ["Metformin is indicated to improve glycemic control in type 2 diabetes."],
  warnings_and_cautions: ["Lactic acidosis has been reported."],
  adverse_reactions: ["Diarrhea and nausea are common."],
  dosage_and_administration: ["DOSING-TEXT-NEVER-SENT start at a low amount with meals."],
  overdosage: ["OVERDOSE-TEXT-NEVER-SENT hemodialysis may be used."],
};
const LABEL_COMBO = {
  set_id: "set-combo", effective_time: "20260101", id: "label-2",
  openfda: { generic_name: ["SITAGLIPTIN AND METFORMIN HYDROCHLORIDE"], substance_name: ["SITAGLIPTIN", "METFORMIN HYDROCHLORIDE"], product_type: ["HUMAN PRESCRIPTION DRUG"] },
  indications_and_usage: ["COMBO-TEXT for the combination."],
};
const LABEL_OTC = {
  set_id: "set-single-otc", effective_time: "20260201", id: "label-3",
  openfda: { generic_name: ["METFORMIN HYDROCHLORIDE"], substance_name: ["METFORMIN HYDROCHLORIDE"], product_type: ["HUMAN OTC DRUG"] },
  indications_and_usage: ["OTC-TEXT."],
};

const PUBCHEM_RECORD = {
  Record: {
    RecordNumber: 4091,
    Section: [
      { TOCHeading: "Pharmacology and Biochemistry", Section: [
        { TOCHeading: "MeSH Pharmacological Classification", Information: [{ ReferenceNumber: 1, Name: "Hypoglycemic Agents", Value: { StringWithMarkup: [{ String: "MESH-TEXT Hypoglycemic agents lower blood glucose." }] } }] },
        { TOCHeading: "FDA Pharmacological Classification", Information: [{ ReferenceNumber: 2, Value: { StringWithMarkup: [{ String: "FDACLASS-TEXT Biguanide [EPC]" }] } }] },
        { TOCHeading: "Mechanism of Action", Information: [
          { ReferenceNumber: 3, Value: { StringWithMarkup: [{ String: "DRUGBANK-TEXT decreases hepatic glucose production." }] } },
          { ReferenceNumber: 4, Value: { StringWithMarkup: [{ String: "HSDB-TEXT quoted from a journal." }] } },
        ] },
      ] },
      { TOCHeading: "Drug and Medication Information", Section: [
        { TOCHeading: "LiverTox Summary", Information: [{ ReferenceNumber: 5, Value: { StringWithMarkup: [{ String: "LIVERTOX-TEXT Metformin is rarely linked to liver injury." }] } }] },
        { TOCHeading: "Drug Indication", Information: [
          { ReferenceNumber: 6, Value: { StringWithMarkup: [{ String: "STATPEARLS-TEXT used for diabetes." }] } },
          { ReferenceNumber: 7, Value: { StringWithMarkup: [{ String: "CHEMBL-TEXT indication." }] } },
        ] },
      ] },
      { TOCHeading: "Toxicity", Section: [{ TOCHeading: "Toxicological Information", Section: [
        { TOCHeading: "Effects During Pregnancy and Lactation", Information: [{ ReferenceNumber: 8, Value: { StringWithMarkup: [{ String: "LACTMED-TEXT Metformin passes into milk in small amounts." }] } }] },
      ] }] },
    ],
    Reference: [
      { ReferenceNumber: 1, SourceName: "Medical Subject Headings (MeSH)", LicenseURL: "https://www.nlm.nih.gov/copyright.html", URL: "https://www.ncbi.nlm.nih.gov/mesh/68007004" },
      { ReferenceNumber: 2, SourceName: "FDA Pharm Classes", LicenseURL: "https://www.fda.gov/about-fda/about-website/website-policies#linking" },
      { ReferenceNumber: 3, SourceName: "DrugBank", LicenseURL: "https://www.drugbank.ca/legal/terms_of_use" },
      { ReferenceNumber: 4, SourceName: "Hazardous Substances Data Bank (HSDB)", LicenseURL: "https://www.nlm.nih.gov/web_policies.html" },
      { ReferenceNumber: 5, SourceName: "LiverTox", LicenseURL: "https://www.nlm.nih.gov/copyright.html", URL: "https://www.ncbi.nlm.nih.gov/books/n/livertox/Metformin/" },
      { ReferenceNumber: 6, SourceName: "StatPearls" },
      { ReferenceNumber: 7, SourceName: "ChEMBL", LicenseURL: "http://www.ebi.ac.uk/Information/termsofuse.html" },
      { ReferenceNumber: 8, SourceName: "Drugs and Lactation Database (LactMed)", LicenseURL: "https://www.nlm.nih.gov/copyright.html" },
    ],
  },
};

const allText = (sources: readonly DraftSourceInput[]): string => sources.map((s) => `${s.title}\n${s.text}`).join("\n");

describe("spec #883 — the fetchers (no database)", () => {
  it("spec #883 D1 openFDA: the single-ingredient prescription label becomes one source, licence named, no dosing or overdose text", async () => {
    const asked: string[] = [];
    const fetch = fakeFetch([["api.fda.gov/drug/label.json", { results: [LABEL_COMBO, LABEL_OTC, LABEL_SINGLE] }]], asked);
    const src = await fetchOpenFdaSource("Metformin", "fda1", { fetch, retrievedOn: ON });
    expect(asked.some((u) => u.includes("api.fda.gov"))).toBe(true);
    expect(src).not.toBeNull();
    expect(src!.kind).toBe("openfda");
    expect(src!.ref).toBe("fda1");
    expect(src!.asOf).toBe("2025-03-10");
    expect(src!.url).toContain("set-single-rx");
    expect(src!.title.toLowerCase()).toContain("public domain");
    expect(src!.text).toContain("glycemic control");
    expect(src!.text).not.toContain("DOSING-TEXT-NEVER-SENT");
    expect(src!.text).not.toContain("OVERDOSE-TEXT-NEVER-SENT");
    expect(src!.text).not.toContain("COMBO-TEXT");
    expect(src!.text).not.toContain("OTC-TEXT");

    expect(await fetchOpenFdaSource("Metformin", "fda1", { fetch: fakeFetch([]), retrievedOn: ON })).toBeNull();
    expect(await fetchOpenFdaSource("Metformin", "fda1", { fetch: fakeFetch([["api.fda.gov", { results: [LABEL_COMBO] }]]), retrievedOn: ON })).toBeNull();
  });

  it("spec #883 D2 PubChem: only LiverTox, LactMed, MeSH and FDA Pharm Classes text is kept, each its own source with its licence", async () => {
    const fetch = fakeFetch([
      ["/compound/name/", { IdentifierList: { CID: [4091] } }],
      ["/pug_view/data/compound/4091", PUBCHEM_RECORD],
    ]);
    const sources = await fetchPubchemSources("Metformin", "1", { fetch, retrievedOn: ON });
    const text = allText(sources);
    for (const kept of ["LIVERTOX-TEXT", "LACTMED-TEXT", "MESH-TEXT", "FDACLASS-TEXT"]) expect(text).toContain(kept);
    for (const gone of ["DRUGBANK-TEXT", "STATPEARLS-TEXT", "HSDB-TEXT", "CHEMBL-TEXT"]) expect(text).not.toContain(gone);
    expect(sources).toHaveLength(4);
    expect(new Set(sources.map((s) => s.ref)).size).toBe(4);
    const by = (frag: string) => sources.find((s) => s.text.includes(frag))!;
    expect(by("LIVERTOX-TEXT").kind).toBe("livertox");
    expect(by("LACTMED-TEXT").kind).toBe("lactmed");
    expect(by("MESH-TEXT").kind).toBe("pubchem");
    expect(by("LIVERTOX-TEXT").title).toContain("LiverTox");
    expect(by("LACTMED-TEXT").title).toContain("LactMed");
    expect(by("MESH-TEXT").title).toContain("MeSH");
    expect(by("FDACLASS-TEXT").title).toContain("FDA");
    for (const s of sources) {
      expect(s.title.toLowerCase()).toContain("public domain");
      expect(s.asOf).toBe(ON);
    }
  });
});

describe("spec #883 — the batch job", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  let seq = 0;
  /** A generic; `stocked` also gives it a medicine and a stocked item. */
  const generic = async (name: string, stocked: boolean): Promise<string> => {
    seq += 1;
    const sctid = `88300${String(seq).padStart(5, "0")}`;
    await db.insert(formularyGenerics).values({
      id: newId(), sctid, name, nameNormalized: name.toLowerCase(), doseForm: "oral tablet", routeOfAdministration: "oral",
      source: "nrces-2026-09", createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id,
    });
    if (stocked) {
      const medicineId = await withTx(db, async (tx) => {
        const salt = await addSalt(tx, PHARMACIST, { name: `${name} salt ${String(seq)}` });
        return (await addMedicine(tx, PHARMACIST, { brandName: `Brand ${String(seq)}`, form: "tablet", routeClass: "systemic", strengthLabel: "1 unit", salts: [{ saltId: salt.saltId, strength: "1 unit" }] })).medicineId;
      });
      await db.update(formularyMedicines).set({ genericSctid: sctid }).where(eq(formularyMedicines.id, medicineId));
      await withTx(db, (tx) => registerItem(tx, PHARMACIST, {
        code: `IT${String(seq)}`, name: `${name} item`, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId,
        gstRateBps: 500, uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      }));
    }
    return sctid;
  };

  const source = (g: { name: string }): DraftSourceInput[] => [
    { ref: "fda1", kind: "openfda", title: `US FDA label · ${g.name} · public domain (openFDA, CC0)`, url: null, asOf: "2025-01-01", text: `${g.name} treats a condition. Nausea may occur.` },
  ];
  const model = (seen: CompleteInput[] = [], fail: (u: string) => boolean = () => false): InferenceClient => ({
    async complete(input) {
      seen.push(input);
      if (fail(input.user)) throw new Error("provider_failed");
      return { text: JSON.stringify({ fields: { uses: [{ text: "Treats a condition.", source: "fda1" }], commonSideEffects: [{ text: "Nausea.", source: "fda1" }] } }), usage: { inputTokens: 1000, outputTokens: 250 } };
    },
  });

  it("spec #883 D3 picks stocked generics with no CRK entry, in name order, up to the limit (20 by default, at most 50)", async () => {
    await generic("Zinc sulfate", true);
    await generic("Amoxicillin", true);
    await generic("Metformin", true);
    await generic("Not stocked", false);
    const done = await generic("Aciclovir", true);
    await runCrkDraftBatch(db, PHARMACIST, { limit: 1, model: { client: model(), id: "test-model" }, sourcesFor: async (g) => (g.sctid === done ? source(g) : []) });
    // Aciclovir sorts first and is drafted above; the rest wait.
    expect((await db.select().from(formularyCrkEntries)).length).toBe(1);
    const picked = await stockedGenericsToDraft(db, 2);
    expect(picked.map((g) => g.name)).toEqual(["Amoxicillin", "Metformin"]);
    expect((await stockedGenericsToDraft(db)).map((g) => g.name)).toEqual(["Amoxicillin", "Metformin", "Zinc sulfate"]);
    expect(CRK_BATCH_DEFAULT).toBe(20);
    expect(CRK_BATCH_MAX).toBe(50);
    for (let i = 0; i < 55; i += 1) await generic(`Bulk ${String(i).padStart(2, "0")}`, true);
    expect(await stockedGenericsToDraft(db)).toHaveLength(20);
    expect(await stockedGenericsToDraft(db, 500)).toHaveLength(50);
  });

  it("spec #883 D4 each generic goes through the drafter with tokens on its row; no source ⇒ no_source and no model call; one failure does not stop the rest", async () => {
    const a = await generic("Amoxicillin", true);
    const b = await generic("Bisoprolol", true);
    const c = await generic("Cetirizine", true);
    const seen: CompleteInput[] = [];
    const out = await runCrkDraftBatch(db, PHARMACIST, {
      model: { client: model(seen, (u) => u.includes("Amoxicillin")), id: "test-model" },
      sourcesFor: async (g) => (g.sctid === b ? [] : source(g)),
    });
    expect(out.map((o) => [o.sctid, o.status])).toEqual([[a, "failed"], [b, "no_source"], [c, "drafted"]]);
    expect(seen).toHaveLength(2);
    expect(seen.some((s) => s.user.includes("Bisoprolol"))).toBe(false);
    const rows = await db.select().from(formularyCrkEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ draftedModel: "test-model", modelDrafts: 1, modelInputTokens: 1000, modelOutputTokens: 250, draftUsage: { inputTokens: 1000, outputTokens: 250 } });
    expect(out.find((o) => o.sctid === c)).toMatchObject({ usage: { inputTokens: 1000, outputTokens: 250 }, statements: 2 });
  });

  it("spec #883 D5 nothing is published: every entry is an unsigned draft on the worklist and the doctor's reader returns nothing", async () => {
    const ids = [await generic("Amlodipine", true), await generic("Atenolol", true)];
    const out = await runCrkDraftBatch(db, PHARMACIST, { model: { client: model(), id: "test-model" }, sourcesFor: async (g) => source(g) });
    expect(out.every((o) => o.status === "drafted")).toBe(true);
    for (const r of await db.select().from(formularyCrkEntries)) {
      expect(r.signedCrk).toBeNull();
      expect(r.version).toBe(0);
      expect(r.firstSignedBy).toBeNull();
    }
    for (const id of ids) expect(await signedCrkForGeneric(db, id, ON)).toBeUndefined();
    const w = await crkWorklist(db, ON);
    expect(w.counts.draft).toBe(2);
    expect(w.counts.signed).toBe(0);
    expect(w.items.every((i) => i.state === "draft")).toBe(true);
  });

  it("spec #883 D6 no model configured: refuses model_not_configured before fetching or writing anything", async () => {
    await generic("Amlodipine", true);
    let fetched = 0;
    const err = await runCrkDraftBatch(db, PHARMACIST, { model: { client: null, id: null }, sourcesFor: async (g) => { fetched += 1; return source(g); } })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FormularyError);
    expect((err as FormularyError).code).toBe("model_not_configured");
    expect(fetched).toBe(0);
    expect(await db.select().from(formularyCrkEntries)).toHaveLength(0);
  });
});

describe("spec #883 — the cost report", () => {
  it("spec #883 D7 tokens per draft, dollars per draft and in total at the given prices, and a projection for N drafts", () => {
    const r = crkCostReport(
      [
        { name: "A", usage: { inputTokens: 10_000, outputTokens: 2_000 } },
        { name: "B", usage: { inputTokens: 30_000, outputTokens: 4_000 } },
      ],
      { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
      300,
    );
    expect(r.drafts).toEqual([
      { name: "A", inputTokens: 10_000, outputTokens: 2_000, usd: 0.036 },
      { name: "B", inputTokens: 30_000, outputTokens: 4_000, usd: 0.092 },
    ]);
    expect(r.total).toEqual({ drafts: 2, inputTokens: 40_000, outputTokens: 6_000, usd: 0.128 });
    expect(r.average.usd).toBeCloseTo(0.064, 6);
    expect(r.projected).toEqual({ drafts: 300, usd: expect.closeTo(19.2, 6) as unknown as number });
  });
});
