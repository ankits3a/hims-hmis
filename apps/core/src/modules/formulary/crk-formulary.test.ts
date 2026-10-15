import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyCrkEntries, formularyCrkSignatures, formularyGenerics, formularyMedicines } from "../../kernel/db/schema";
import { registerItem } from "../materials";
import { FormularyError } from "./errors";
import { addMedicine, addSalt } from "./masters";
import { getMonograph, renalDoseFor, reviewMonograph, saveMonograph } from "./monographs";
import { crkEntryForReview, crkLabel, crkWorklist, draftCrkEntry, isOverdue, sanitiseModelDraft, saveCrkEntry, signCrkEntry, signedCrkForGeneric, signedCrkForMedicines } from "./crk-formulary";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { CrkEntry } from "../../kernel/db/schema";
import type { CompleteInput, InferenceClient } from "../../kernel/inference/types";

/**
 * #618 / #884 / decision 0053 — the CRK formulary. The model only drafts; nothing is read until a Pharmacology
 * reviewer signs; a high-alert medicine needs a second, different signer; no model configured leaves the
 * hand path working. The entry has its own state: the last signed version stays live while a new one is
 * pending, and neither touches the pharmacy's monograph.
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
  const live = async (): Promise<CrkEntry | undefined> => (await signedCrkForGeneric(db, SCTID, "2026-10-15"))?.crk;
  const entryRow = async () => (await db.select().from(formularyCrkEntries))[0]!;
  const save = (entry: CrkEntry = ENTRY, actor: Actor = PHARMACIST) => withTx(db, (tx) => saveCrkEntry(tx, actor, SCTID, entry));
  const sign = (id: string, actor: Actor, extra: { crk?: CrkEntry; highAlert?: boolean } = {}) =>
    withTx(db, (tx) => signCrkEntry(tx, actor, id, { designation: "Professor, Pharmacology", ...extra }));
  const CHANGED: CrkEntry = { ...ENTRY, fields: { uses: [{ text: "Changed.", source: "fda1" }] } };

  it("no model configured: drafting answers model_not_configured and writes nothing; the hand path still signs", async () => {
    expect(await code(draftCrkEntry(db, PHARMACIST, { genericSctid: SCTID, sources: SOURCES }, { client: null, id: null }))).toBe("model_not_configured");
    expect(await db.select().from(formularyCrkEntries)).toHaveLength(0);
    const { entryId } = await save();
    expect(await sign(entryId, PROF_A)).toEqual({ status: "reviewed", version: 1, renewal: false });
    expect((await live())?.fields.uses?.[0]?.text).toBe("Treats shingles and cold sores.");
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
    expect(await live()).toBeUndefined();
    const draft = await crkEntryForReview(db, SCTID);
    expect(draft?.draftCrk?.fields).toEqual({ uses: [{ text: "Treats shingles.", source: "fda1" }], howToTake: [{ text: "Swallow with water.", source: "fda1" }] });
    expect(draft).toMatchObject({ signedCrk: null, draftedModel: "gpt-test", draftUsage: { inputTokens: 1200, outputTokens: 300 } });
    expect(await db.select().from(events).where(eq(events.name, "crk.draft_saved"))).toHaveLength(1);
    // the cost of the drafts so far is on the reviewers' worklist (#618: measured on the first 20), and survives the signature
    expect((await crkWorklist(db, "2026-10-15")).drafting).toEqual({ drafted: 1, inputTokens: 1200, outputTokens: 300 });
    await sign(res.entryId, PROF_A);
    expect((await crkWorklist(db, "2026-10-15")).drafting).toEqual({ drafted: 1, inputTokens: 1200, outputTokens: 300 });
  });

  it("review Low: a count without a unit, a sig or a schedule is a dose; a masking placeholder echo is dropped", () => {
    const sources = [{ ref: "fda1", kind: "openfda", title: "t", url: null, asOf: null }];
    const st = (text: string) => ({ text, source: "fda1" });
    const { fields, dropped } = sanitiseModelDraft({ fields: { howToTake: [
      st("Take 2 tablets at night."), st("1 tab twice a day."), st("Two capsules with food."), st("Use 1 puff when needed."),
      st("Take 1-0-1 after meals."), st("Take every 8 hours."), st("Take 3 times a day."), st("Take twice daily."),
      st("Call <<P1>> for advice."), st("Swallow whole with water."),
    ] } }, sources);
    expect(fields).toEqual({ howToTake: [st("Swallow whole with water.")] });
    expect(dropped).toBe(9);
  });

  it("the label every reader shows names the signer and the date", () => {
    expect(crkLabel("Dr A", "2026-10-15")).toBe("CRK Medical College formulary · reviewed by Dr A, 2026-10-15");
  });

  it("an unparseable model answer writes nothing", async () => {
    const bad: InferenceClient = { complete: async () => ({ text: "sorry, I cannot" }) };
    expect(await code(draftCrkEntry(db, PHARMACIST, { genericSctid: SCTID, sources: SOURCES }, { client: bad, id: "m" }))).toBe("draft_failed");
    expect(await db.select().from(formularyCrkEntries)).toHaveLength(0);
  });

  it("a hand-written statement must cite one of the entry's own sources", async () => {
    expect(await code(save({ ...ENTRY, fields: { uses: [{ text: "x", source: "nowhere" }] } }))).toBe("invalid_crk");
    expect(await code(save({ ...ENTRY, sources: [{ ...ENTRY.sources[0]!, kind: "1mg" }] }))).toBe("invalid_crk");
  });

  it("one signature: live, versioned, due in twelve months, kept as signed; the reviewer may edit as they sign", async () => {
    const { entryId } = await save();
    const edited = { ...ENTRY, fields: { uses: [{ text: "Treats shingles.", source: "fda1" }] } };
    await sign(entryId, PROF_A, { crk: edited });
    const row = await entryRow();
    expect(row).toMatchObject({ signedCrk: edited, draftCrk: null, reviewedBy: PROF_A.id, reviewerDesignation: "Professor, Pharmacology", version: 1 });
    expect(row.reviewDueOn! > new Date(Date.now() + 360 * 86_400_000).toISOString().slice(0, 10)).toBe(true);
    const sigs = await db.select().from(formularyCrkSignatures);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ kind: "sole", version: 1, signedBy: PROF_A.id, crk: edited });
    expect(await code(sign(entryId, PROF_B))).toBe("monograph_already_reviewed");
  });

  it("high-alert: the first signature waits, the same person cannot sign twice, a second reviewer makes it read", async () => {
    const { entryId } = await save();
    expect(await sign(entryId, PROF_A, { highAlert: true })).toEqual({ status: "awaiting_second", version: 0, renewal: false });
    expect(await live()).toBeUndefined();
    expect(await code(sign(entryId, PROF_A))).toBe("monograph_same_actor");
    expect(await sign(entryId, PROF_B)).toEqual({ status: "reviewed", version: 1, renewal: false });
    expect(await entryRow()).toMatchObject({ reviewedBy: PROF_A.id, secondReviewedBy: PROF_B.id, highAlert: true, firstSignedBy: null, draftCrk: null });
    expect((await db.select().from(formularyCrkSignatures)).map((s) => s.kind).sort()).toEqual(["first", "second"]);
  });

  it("an edit at the second signature restarts the pair: it is a first signature again", async () => {
    const { entryId } = await save();
    await sign(entryId, PROF_A, { highAlert: true });
    expect(await sign(entryId, PROF_B, { crk: { ...ENTRY, fields: { uses: [{ text: "Shingles.", source: "fda1" }] } } }))
      .toEqual({ status: "awaiting_second", version: 0, renewal: false });
    expect(await sign(entryId, PROF_A)).toEqual({ status: "reviewed", version: 1, renewal: false });
  });

  it("review Low: removing the high-alert flag clears a stale first signature; this signature alone decides", async () => {
    const { entryId } = await save();
    await sign(entryId, PROF_A, { highAlert: true });
    expect(await sign(entryId, PROF_B, { highAlert: false })).toEqual({ status: "reviewed", version: 1, renewal: false });
    expect(await entryRow()).toMatchObject({ highAlert: false, reviewedBy: PROF_B.id, secondReviewedBy: null, firstSignedBy: null, firstSignedAt: null, firstSignerDesignation: null });
  });

  const stockedHighAlert = async (): Promise<string> => {
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
    return medicineId;
  };

  it("a stocked item flagged high-alert makes the generic high-alert whatever the reviewer says", async () => {
    await stockedHighAlert();
    const { entryId } = await save();
    expect(await sign(entryId, PROF_A, { highAlert: false })).toEqual({ status: "awaiting_second", version: 0, renewal: false });
    // the entry carries the high-alert it was signed under, so every reader shows it
    await sign(entryId, PROF_B);
    expect(await signedCrkForGeneric(db, SCTID, "2026-10-15")).toMatchObject({ highAlert: true });
  });

  it("a new version waits beside the live one; signing it replaces the live text", async () => {
    const { entryId } = await save();
    await sign(entryId, PROF_A);
    await save(CHANGED);
    expect(await entryRow()).toMatchObject({ signedCrk: ENTRY, draftCrk: CHANGED, version: 1 });
    expect(await sign(entryId, PROF_B)).toEqual({ status: "reviewed", version: 2, renewal: false });
    expect(await live()).toEqual(CHANGED);
    expect(await entryRow()).toMatchObject({ draftCrk: null, reviewedBy: PROF_B.id });
  });

  it("the worklist counts drafts, pending versions, pairs waiting and entries due again", async () => {
    const { entryId } = await save();
    let w = await crkWorklist(db, "2026-10-15");
    expect(w.counts).toMatchObject({ draft: 1, pending: 0, awaitingSecond: 0, signed: 0 });
    expect(w.items.map((i) => i.state)).toEqual(["draft"]);
    await sign(entryId, PROF_A, { highAlert: true });
    w = await crkWorklist(db, "2026-10-15");
    expect(w.counts).toMatchObject({ draft: 0, awaitingSecond: 1 });
    await sign(entryId, PROF_B);
    w = await crkWorklist(db, "2099-01-01");
    expect(w.counts).toMatchObject({ signed: 1, overdue: 1, dueForReview: 0 });
    expect(w.items.map((i) => i.state)).toEqual(["overdue"]);
    await save(CHANGED);
    w = await crkWorklist(db, "2026-10-15");
    expect(w.counts).toMatchObject({ signed: 1, pending: 1, draft: 0 });
    expect(w.items.map((i) => i.state)).toEqual(["pending"]);
  });

  /* #884 — the 12-month renewal. Every date below is passed in; nothing reads the real clock. */
  const at = (iso: string): Date => new Date(`${iso}T06:00:00.000Z`);
  const signAt = (id: string, actor: Actor, iso: string, extra: { crk?: CrkEntry; highAlert?: boolean } = {}) =>
    withTx(db, (tx) => signCrkEntry(tx, actor, id, { designation: "Professor, Pharmacology", ...extra }, at(iso)));
  const kinds = async (): Promise<string[]> => (await db.select().from(formularyCrkSignatures).orderBy(formularyCrkSignatures.signedAt)).map((r) => r.kind);

  it("#884: an unchanged entry is re-affirmed in its window; it stays read throughout; due moves 12 months; audited", async () => {
    const { entryId } = await save();
    await signAt(entryId, PROF_A, "2026-01-10");
    expect(await entryRow()).toMatchObject({ reviewDueOn: "2027-01-10", version: 1 });
    // not yet: the window opens 30 days before the due date
    expect(await code(signAt(entryId, PROF_B, "2026-11-01"))).toBe("monograph_already_reviewed");
    // overdue: still read, by every reader, and flagged
    expect(await signedCrkForGeneric(db, SCTID, "2027-01-20")).toMatchObject({ overdue: true, crk: ENTRY });
    expect(await signAt(entryId, PROF_B, "2027-01-20")).toEqual({ status: "reviewed", version: 2, renewal: true });
    expect(await entryRow()).toMatchObject({ signedCrk: ENTRY, reviewedBy: PROF_B.id, reviewDueOn: "2028-01-20", version: 2, firstSignedBy: null });
    expect(await kinds()).toEqual(["sole", "renewal"]);
    const signedEvents = await db.select().from(events).where(eq(events.name, "crk.signed"));
    expect(signedEvents.map((e) => (e.payload as { renewal: boolean }).renewal)).toEqual([false, true]);
  });

  it("#884: edits sent at renewal time are a new version, not a renewal; the live one stays until signed", async () => {
    const { entryId } = await save();
    await signAt(entryId, PROF_A, "2026-01-10", { highAlert: true });
    await signAt(entryId, PROF_B, "2026-01-10");
    expect(await signAt(entryId, PROF_A, "2027-01-20", { crk: CHANGED })).toEqual({ status: "awaiting_second", version: 1, renewal: false });
    expect(await live()).toEqual(ENTRY);
  });

  it("#884: a high-alert renewal takes two different signers, and the entry stays read while the first waits", async () => {
    const { entryId } = await save();
    await signAt(entryId, PROF_A, "2026-01-10", { highAlert: true });
    await signAt(entryId, PROF_B, "2026-01-11");
    expect(await signAt(entryId, PROF_A, "2027-01-05")).toEqual({ status: "awaiting_second", version: 1, renewal: true });
    expect(await signedCrkForGeneric(db, SCTID, "2027-01-05")).toMatchObject({ reviewDueOn: "2027-01-11", crk: ENTRY });
    expect(await code(signAt(entryId, PROF_A, "2027-01-06"))).toBe("monograph_same_actor");
    expect(await signAt(entryId, PROF_B, "2027-01-06")).toEqual({ status: "reviewed", version: 2, renewal: true });
    expect(await entryRow()).toMatchObject({ reviewedBy: PROF_A.id, secondReviewedBy: PROF_B.id, reviewDueOn: "2028-01-06", firstSignedBy: null });
    expect(await kinds()).toEqual(["first", "second", "renewal_first", "renewal_second"]);
  });

  it("#884: the worklist names an entry due soon, overdue, or waiting for its second renewal signer", async () => {
    const { entryId } = await save();
    await signAt(entryId, PROF_A, "2026-01-10", { highAlert: true });
    await signAt(entryId, PROF_B, "2026-01-10");
    expect((await crkWorklist(db, "2026-06-01")).items).toEqual([]);
    let w = await crkWorklist(db, "2026-12-20");
    expect(w.counts).toMatchObject({ dueForReview: 1, overdue: 0 });
    expect(w.items.map((i) => i.state)).toEqual(["due"]);
    w = await crkWorklist(db, "2027-02-01");
    expect(w.counts).toMatchObject({ dueForReview: 0, overdue: 1 });
    expect(w.items.map((i) => i.state)).toEqual(["overdue"]);
    await signAt(entryId, PROF_A, "2027-02-01");
    w = await crkWorklist(db, "2027-02-01");
    expect(w.counts).toMatchObject({ awaitingSecond: 1, signed: 1 });
    expect(w.items.map((i) => i.state)).toEqual(["awaiting_second"]);
  });

  it("#884: overdue is the day after the due date, never the due date itself", () => {
    expect(isOverdue("2027-01-10", "2027-01-10")).toBe(false);
    expect(isOverdue("2027-01-10", "2027-01-11")).toBe(true);
    expect(isOverdue(null, "2099-01-01")).toBe(false);
  });

  /* ═══ REVIEW (Medium) — the CRK entry and the pharmacy monograph have SEPARATE states ═══ */
  const MS: Actor = { type: "user", id: "01HMEDSUPT0000000000000001" };
  const pharmacyMonograph = async (): Promise<string> => {
    const { monographId } = await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, {
      genericSctid: SCTID, sourceVersion: "1.25", patient: { what_it_is: "An antiviral." },
      renalDoses: [{ crclMin: null, crclMax: 10, dose: "800 mg every 12 hours", severity: "reduce" }],
    }));
    return monographId;
  };

  it("seam: a CRK draft or edit leaves the pharmacy's reviewed renal bands answering", async () => {
    const monographId = await pharmacyMonograph();
    await withTx(db, (tx) => reviewMonograph(tx, MS, monographId));
    expect(await renalDoseFor(db, genericId, 5)).not.toBeNull();
    await save();
    expect(await renalDoseFor(db, genericId, 5)).not.toBeNull();
    expect((await getMonograph(db, SCTID))?.status).toBe("reviewed");
  });

  it("seam: a CRK signature does not publish the pharmacy's draft sections or bands", async () => {
    await pharmacyMonograph();
    const { entryId } = await save();
    await sign(entryId, PROF_A);
    expect(await getMonograph(db, SCTID)).toBeUndefined();
    expect(await renalDoseFor(db, genericId, 5)).toBeNull();
  });

  it("seam: the signed version stays read by doctors while a new draft is pending", async () => {
    const { entryId } = await save();
    await sign(entryId, PROF_A);
    await save(CHANGED);
    expect((await live())?.fields.uses?.[0]?.text).toBe("Treats shingles and cold sores.");
  });

  it("seam: a pharmacy act never touches the CRK entry", async () => {
    const { entryId } = await save();
    await sign(entryId, PROF_A);
    const monographId = await pharmacyMonograph();
    await withTx(db, (tx) => reviewMonograph(tx, MS, monographId));
    await withTx(db, (tx) => saveMonograph(tx, PHARMACIST, { genericSctid: SCTID, sourceVersion: "1.26" }));
    expect(await live()).toEqual(ENTRY);
    expect(await entryRow()).toMatchObject({ version: 1, draftCrk: null });
  });

  it("#882: a doctor's medicine reads the LIVE entry with its label; nothing while unsigned; the live one while a draft waits", async () => {
    const medicineId = await stockedHighAlert();
    const { entryId } = await save();
    expect(await signedCrkForMedicines(db, [medicineId])).toEqual([]);
    await sign(entryId, PROF_A);
    expect(await signedCrkForMedicines(db, [medicineId])).toEqual([]);
    await sign(entryId, PROF_B);
    const [read] = await signedCrkForMedicines(db, [medicineId, medicineId]);
    expect(read).toMatchObject({ medicineId, genericSctid: SCTID, highAlert: true, designation: "Professor, Pharmacology", version: 1 });
    expect(read!.label).toMatch(/^CRK Medical College formulary · reviewed by .+, \d{4}-\d{2}-\d{2}$/);
    expect(read!.crk).toEqual(ENTRY);
    expect(Object.keys(read!)).not.toContain("draftUsage");
    expect(Object.keys(read!)).not.toContain("draftCrk");
    await save(CHANGED);
    expect((await signedCrkForMedicines(db, [medicineId]))[0]?.crk).toEqual(ENTRY);
    // #884 — past its due date the doctor still reads it, flagged overdue
    const due = (await entryRow()).reviewDueOn!;
    expect((await signedCrkForMedicines(db, [medicineId], due))[0]?.overdue).toBe(false);
    expect((await signedCrkForMedicines(db, [medicineId], "2999-01-01"))[0]?.overdue).toBe(true);
  });

  it("only a person signs, and a signature names a designation", async () => {
    const { entryId } = await save();
    expect(await code(withTx(db, (tx) => signCrkEntry(tx, { type: "agent", id: "bot" } as Actor, entryId, { designation: "x" })))).toBe("attester_not_user");
    expect(await code(withTx(db, (tx) => signCrkEntry(tx, PROF_A, entryId, { designation: "  " })))).toBe("invalid_crk");
    expect(await code(withTx(db, (tx) => signCrkEntry(tx, PROF_A, "no-such", { designation: "x" })))).toBe("unknown_crk_entry");
  });
});
