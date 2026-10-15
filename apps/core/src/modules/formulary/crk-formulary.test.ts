import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyGenerics, formularyMedicines, formularyMonographs, formularyMonographSignatures } from "../../kernel/db/schema";
import { registerItem } from "../materials";
import { FormularyError } from "./errors";
import { addMedicine, addSalt } from "./masters";
import { getMonograph, reviewMonograph, saveMonograph } from "./monographs";
import { crkLabel, crkWorklist, draftCrkEntry, saveCrkEntry, signCrkEntry, signedCrkForMedicines } from "./crk-formulary";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { CrkEntry } from "../../kernel/db/schema";
import type { CompleteInput, InferenceClient } from "../../kernel/inference/types";

/**
 * #618 / decision 0053 — the CRK formulary. The model only drafts; nothing is read until a Pharmacology
 * reviewer signs; a high-alert medicine needs a second, different signer; no model configured leaves the
 * hand path working.
 */

const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const PROF_A: Actor = { type: "user", id: "01HPROFA000000000000000001" };
const PROF_B: Actor = { type: "user", id: "01HPROFB000000000000000001" };
const SCTID = "1201952000";

const SOURCES = [
  { ref: "fda1", kind: "openfda" as const, title: "Aciclovir tablets label", url: null, asOf: "2025-01-01",
    text: "Indicated for herpes zoster. Take with water. Nausea may occur. Call 9876543210 for questions. Usual dose 800 mg five times daily." },
];

function fakeModel(answer: unknown, seen: CompleteInput[] = []): InferenceClient {
  return {
    async complete(input) {
      seen.push(input);
      return { text: JSON.stringify(answer), usage: { inputTokens: 1200, outputTokens: 300 } };
    },
  };
}

const ENTRY: CrkEntry = {
  sources: [{ ref: "fda1", kind: "openfda", title: "Aciclovir tablets label", url: null, asOf: "2025-01-01" }],
  fields: { uses: [{ text: "Treats shingles and cold sores.", source: "fda1" }] },
  combinationNote: null,
};

describe("CRK formulary — drafted by a model, signed by Pharmacology", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let genericId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    genericId = newId();
    await db.insert(formularyGenerics).values({
      id: genericId, sctid: SCTID, name: "Acyclovir 800 mg oral tablet", nameNormalized: "acyclovir 800 mg oral tablet",
      doseForm: "oral tablet", routeOfAdministration: "oral", source: "nrces-2026-09",
      createdBy: PHARMACIST.id, updatedBy: PHARMACIST.id,
    });
  });

  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof FormularyError) return e.code; throw e; }
    return "did not refuse";
  };
  const save = (entry: CrkEntry = ENTRY, actor: Actor = PHARMACIST) => withTx(db, (tx) => saveCrkEntry(tx, actor, SCTID, entry));
  const sign = (id: string, actor: Actor, extra: { crk?: CrkEntry; highAlert?: boolean } = {}) =>
    withTx(db, (tx) => signCrkEntry(tx, actor, id, { designation: "Professor, Pharmacology", ...extra }));

  it("no model configured: drafting answers model_not_configured and writes nothing; the hand path still signs", async () => {
    expect(await code(draftCrkEntry(db, PHARMACIST, { genericSctid: SCTID, sources: SOURCES }, { client: null, id: null }))).toBe("model_not_configured");
    expect(await db.select().from(formularyMonographs)).toHaveLength(0);
    const { monographId } = await save();
    expect(await sign(monographId, PROF_A)).toEqual({ status: "reviewed", version: 1 });
    expect((await getMonograph(db, SCTID))?.crk?.fields.uses?.[0]?.text).toBe("Treats shingles and cold sores.");
  });

  it("a model draft keeps only sourced, dose-free statements, is masked on the way out, and is read by nobody until signed", async () => {
    const seen: CompleteInput[] = [];
    const model = fakeModel({ fields: {
      uses: [{ text: "Treats shingles.", source: "fda1" }, { text: "Treats everything.", source: "blog" }],
      howToTake: [{ text: "Take 800 mg five times a day.", source: "fda1" }, { text: "Swallow with water.", source: "fda1" }],
      madeUp: [{ text: "x", source: "fda1" }],
    } }, seen);
    const res = await draftCrkEntry(db, PHARMACIST, { genericSctid: SCTID, sources: SOURCES }, { client: model, id: "gpt-test" });
    expect(res).toMatchObject({ statements: 2, dropped: 2, usage: { inputTokens: 1200, outputTokens: 300 } });
    expect(seen[0]!.user).not.toContain("9876543210");
    expect(await getMonograph(db, SCTID)).toBeUndefined();
    const draft = await getMonograph(db, SCTID, { includeDraft: true });
    expect(draft?.crk?.fields).toEqual({ uses: [{ text: "Treats shingles.", source: "fda1" }], howToTake: [{ text: "Swallow with water.", source: "fda1" }] });
    expect(draft).toMatchObject({ status: "draft", draftedModel: "gpt-test", draftUsage: { inputTokens: 1200, outputTokens: 300 } });
    expect(await db.select().from(events).where(eq(events.name, "monograph.crk_saved"))).toHaveLength(1);
    // the cost of the drafts so far is on the reviewers' worklist (#618: measured on the first 20)
    expect((await crkWorklist(db, "2026-10-15")).drafting).toEqual({ drafted: 1, inputTokens: 1200, outputTokens: 300 });
  });

  it("the label every reader shows names the signer and the date", () => {
    expect(crkLabel("Dr A", "2026-10-15")).toBe("CRK Medical College formulary · reviewed by Dr A, 2026-10-15");
  });

  it("an unparseable model answer writes nothing", async () => {
    const bad: InferenceClient = { complete: async () => ({ text: "sorry, I cannot" }) };
    expect(await code(draftCrkEntry(db, PHARMACIST, { genericSctid: SCTID, sources: SOURCES }, { client: bad, id: "m" }))).toBe("draft_failed");
    expect(await db.select().from(formularyMonographs)).toHaveLength(0);
  });

  it("a hand-written statement must cite one of the entry's own sources", async () => {
    expect(await code(save({ ...ENTRY, fields: { uses: [{ text: "x", source: "nowhere" }] } }))).toBe("invalid_crk");
    expect(await code(save({ ...ENTRY, sources: [{ ...ENTRY.sources[0]!, kind: "1mg" }] }))).toBe("invalid_crk");
  });

  it("one signature: reviewed, versioned, due in twelve months, kept as signed; the reviewer may edit as they sign", async () => {
    const { monographId } = await save();
    const edited = { ...ENTRY, fields: { uses: [{ text: "Treats shingles.", source: "fda1" }] } };
    await sign(monographId, PROF_A, { crk: edited });
    const row = (await db.select().from(formularyMonographs))[0]!;
    expect(row).toMatchObject({ status: "reviewed", reviewedBy: PROF_A.id, reviewerDesignation: "Professor, Pharmacology", version: 1 });
    expect(row.reviewDueOn! > new Date(Date.now() + 360 * 86_400_000).toISOString().slice(0, 10)).toBe(true);
    const sigs = await db.select().from(formularyMonographSignatures);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ kind: "sole", version: 1, signedBy: PROF_A.id, crk: edited });
    expect(await code(sign(monographId, PROF_B))).toBe("monograph_already_reviewed");
  });

  it("high-alert: the first signature waits, the same person cannot sign twice, a second reviewer makes it read", async () => {
    const { monographId } = await save();
    expect(await sign(monographId, PROF_A, { highAlert: true })).toEqual({ status: "awaiting_second", version: 0 });
    expect(await getMonograph(db, SCTID)).toBeUndefined();
    expect(await code(sign(monographId, PROF_A))).toBe("monograph_same_actor");
    expect(await sign(monographId, PROF_B)).toEqual({ status: "reviewed", version: 1 });
    const row = await getMonograph(db, SCTID);
    expect(row).toMatchObject({ reviewedBy: PROF_A.id, secondReviewedBy: PROF_B.id, highAlert: true, firstSignedBy: null });
    expect((await db.select().from(formularyMonographSignatures)).map((s) => s.kind).sort()).toEqual(["first", "second"]);
  });

  it("an edit at the second signature restarts the pair: it is a first signature again", async () => {
    const { monographId } = await save();
    await sign(monographId, PROF_A, { highAlert: true });
    expect(await sign(monographId, PROF_B, { crk: { ...ENTRY, fields: { uses: [{ text: "Shingles.", source: "fda1" }] } } }))
      .toEqual({ status: "awaiting_second", version: 0 });
    expect(await sign(monographId, PROF_A)).toEqual({ status: "reviewed", version: 1 });
  });

  it("a stocked item flagged high-alert makes the generic high-alert whatever the reviewer says", async () => {
    const medicineId = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, PHARMACIST, { name: "Aciclovir", drugClass: "antiviral" });
      const m = await addMedicine(tx, PHARMACIST, { brandName: "Zovirax 800", form: "tablet", routeClass: "systemic", strengthLabel: "800 mg", scheduleFlag: "H", salts: [{ saltId: salt.saltId, strength: "800 mg" }] });
      return m.medicineId;
    });
    await db.update(formularyMedicines).set({ genericSctid: SCTID }).where(eq(formularyMedicines.id, medicineId));
    await withTx(db, (tx) => registerItem(tx, PHARMACIST, {
      code: "ZOV800", name: "Zovirax 800 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId,
      gstRateBps: 1200, highAlert: true, uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }));
    const { monographId } = await save();
    expect(await sign(monographId, PROF_A)).toEqual({ status: "awaiting_second", version: 0 });
  });

  it("any later edit unsigns it; the plain review path refuses a CRK entry", async () => {
    const { monographId } = await save();
    await sign(monographId, PROF_A);
    await save({ ...ENTRY, fields: { uses: [{ text: "Changed.", source: "fda1" }] } });
    expect(await getMonograph(db, SCTID)).toBeUndefined();
    expect(await code(withTx(db, (tx) => reviewMonograph(tx, PROF_B, monographId)))).toBe("monograph_needs_signature");
    // a pharmacist's save of the four sections also unsigns it
    await sign(monographId, PROF_A);
    await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, { genericSctid: SCTID, sourceVersion: "1.25" }));
    expect(await getMonograph(db, SCTID)).toBeUndefined();
  });

  it("the worklist counts drafts, pairs waiting and entries due again", async () => {
    const { monographId } = await save();
    let w = await crkWorklist(db, "2026-10-15");
    expect(w.counts).toMatchObject({ draft: 1, awaitingSecond: 0, signed: 0 });
    expect(w.items.map((i) => i.state)).toEqual(["draft"]);
    await sign(monographId, PROF_A, { highAlert: true });
    w = await crkWorklist(db, "2026-10-15");
    expect(w.counts).toMatchObject({ draft: 0, awaitingSecond: 1 });
    await sign(monographId, PROF_B);
    w = await crkWorklist(db, "2099-01-01");
    expect(w.counts).toMatchObject({ signed: 1, dueForReview: 1 });
    expect(w.items.map((i) => i.state)).toEqual(["due"]);
  });

  it("#882: a doctor's medicine reads the SIGNED entry with its label, and nothing while unsigned", async () => {
    const medicineId = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, PHARMACIST, { name: "Aciclovir", drugClass: "antiviral" });
      return (await addMedicine(tx, PHARMACIST, { brandName: "Zovirax 800", form: "tablet", routeClass: "systemic", strengthLabel: "800 mg", scheduleFlag: "H", salts: [{ saltId: salt.saltId, strength: "800 mg" }] })).medicineId;
    });
    await db.update(formularyMedicines).set({ genericSctid: SCTID }).where(eq(formularyMedicines.id, medicineId));
    const { monographId } = await save();
    expect(await signedCrkForMedicines(db, [medicineId])).toEqual([]);
    await sign(monographId, PROF_A, { highAlert: true });
    expect(await signedCrkForMedicines(db, [medicineId])).toEqual([]);
    await sign(monographId, PROF_B);
    const [read] = await signedCrkForMedicines(db, [medicineId, medicineId]);
    expect(read).toMatchObject({ medicineId, genericSctid: SCTID, highAlert: true, designation: "Professor, Pharmacology" });
    expect(read!.label).toMatch(/^CRK Medical College formulary · reviewed by .+, \d{4}-\d{2}-\d{2}$/);
    expect(read!.crk.fields.uses?.[0]?.text).toBe("Treats shingles and cold sores.");
    expect(Object.keys(read!)).not.toContain("draftUsage");
    await save({ ...ENTRY, fields: { uses: [{ text: "Changed.", source: "fda1" }] } });
    expect(await signedCrkForMedicines(db, [medicineId])).toEqual([]);
  });

  it("only a person signs, and a signature names a designation", async () => {
    const { monographId } = await save();
    expect(await code(withTx(db, (tx) => signCrkEntry(tx, { type: "agent", id: "bot" } as Actor, monographId, { designation: "x" })))).toBe("attester_not_user");
    expect(await code(withTx(db, (tx) => signCrkEntry(tx, PROF_A, monographId, { designation: "  " })))).toBe("invalid_crk");
  });
});
