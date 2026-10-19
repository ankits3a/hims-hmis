import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { loadConfig } from "../../kernel/config";
import { cdsAliases, events, opdComplaintConcepts, opdComplaintTermUsage, opdComplaintTerms } from "../../kernel/db/schema";
import type { ChoiceClient } from "../../kernel/inference/types";
import type { Db } from "../../kernel/db/client";
import { runAliasJob } from "./alias-runner";
import { applyAliasUse, listNicknames, undoNickname } from "./alias-use";
import { complaintConceptsNear, runComplaintAliasProposals } from "./complaint-alias";
import type { ComplaintAliasDeps } from "./complaint-alias";
import { conceptsForTerms, expandComplaintForMatching, recognisedComplaintConcepts, setLearnedComplaintsOn } from "./complaints";
import { recordSignals } from "./consult-guards";
import { openVisit } from "./encounters";

/**
 * #613 — COMPLAINT NORMALISATION THROUGH THE CHOOSER, against the real tables. The chooser is a fake
 * that counts its calls; no network.
 */
const NOW = new Date("2026-08-17T04:00:00.000Z");
const AUDIT = { createdBy: "t", updatedBy: "t" };
const CAPS = { perRun: 40, perDay: 300 };

describe("complaint aliases — live (#613)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let owner: Awaited<ReturnType<typeof mkUser>>;
  let doctors: Awaited<ReturnType<typeof mkDoctor>>[];

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { setLearnedComplaintsOn(false); await teardown(); });
  afterEach(() => { setLearnedComplaintsOn(false); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    clerk = await mkUser(db, "clerk", ["front_office"]);
    owner = await mkUser(db, "owner1", ["owner"]);
    doctors = [];
    for (const [i, name] of ["dra", "drb", "drc"].entries()) doctors.push(await mkDoctor(db, { username: name, departmentId: deptId, roomId: i === 0 ? roomId : room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] }));
    await db.insert(opdComplaintConcepts).values([
      { key: "chest_pain", label: "Chest pain", ...AUDIT },
      { key: "abdominal_pain", label: "Abdominal pain", ...AUDIT },
      { key: "fever", label: "Fever", ...AUDIT },
    ]);
    await db.insert(opdComplaintTerms).values([
      { id: "t1", conceptKey: "chest_pain", term: "chest pain", script: "en", source: "seed", createdBy: "t" },
      { id: "t2", conceptKey: "abdominal_pain", term: "abdominal pain", script: "en", source: "seed", createdBy: "t" },
      { id: "t3", conceptKey: "abdominal_pain", term: "pet dard", script: "hinglish", source: "seed", createdBy: "t" },
      { id: "t4", conceptKey: "fever", term: "fever", script: "en", source: "seed", createdBy: "t" },
    ]);
  });

  async function used(term: string, uses: number, doctor = doctors[0]!): Promise<void> {
    await db.insert(opdComplaintTermUsage).values({ term, doctorId: doctor.doctorId, uses, lastUsedAt: NOW });
  }
  function fake(pick: (phrase: string) => string = () => "abdominal_pain", confidence = 0.97): { deps: ComplaintAliasDeps; asked: string[] } {
    const asked: string[] = [];
    const chooser: ChoiceClient = {
      choose: (input) => {
        asked.push(input.state.phrase ?? "");
        const options = input.questions.concept!.options;
        const want = pick(input.state.phrase ?? "");
        const key = Object.keys(options).find((k) => String(options[k]).toLowerCase().startsWith(want.replace("_", " "))) ?? "none";
        return Promise.resolve({ model: "jev-test-1", answers: { concept: { choice: key, confidence, probabilities: { [key]: confidence } } } });
      },
    };
    return { asked, deps: { enabled: true, concepts: (p) => complaintConceptsNear(db, p), chooser, chooserLine: 0.95 } };
  }
  let phone = 9100000000;
  async function tap(doctor: (typeof doctors)[number], aliasId: string, outcome: "accepted" | "dismissed" = "accepted"): Promise<void> {
    phone += 1;
    const patient = await mkPatient(db, clerk.actor, { name: `Q ${String(phone)}`, phone: String(phone) });
    const encounterId = (await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, NOW)).encounter.id;
    await recordSignals(db, doctor.actor, { misses: [], suggestions: [{ kind: "alias", source: "search", outcome, surface: "consult_web", encounterId, itemKey: aliasId }] }, NOW);
    await applyAliasUse(db, aliasId, NOW);
  }
  const rowOf = async (term: string) => (await db.select().from(cdsAliases).where(eq(cdsAliases.term, term)))[0];

  it("SWITCHED OFF at the scheduler's door: no chooser, no row", async () => {
    await used("pet me marod", 5);
    expect(await runAliasJob(db, loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! }), NOW)).toEqual({ ran: false });
    expect(await db.select().from(cdsAliases)).toEqual([]);
  });

  it("asks only about UNMAPPED phrases committed at least twice, most used first; at the line it is a suggestion naming an existing concept", async () => {
    await used("pet me marod", 3);
    await used("pain, chest", 2, doctors[1]);
    await used("once only", 1);
    await used("pet dard", 9); // a person mapped this: never asked
    const f = fake();
    expect(await runComplaintAliasProposals(db, f.deps, CAPS, NOW)).toEqual({ ran: true, proposed: 2, suggestion: 2, refused: 0, failed: 0 });
    // The rule answered "pain, chest" (same words as "chest pain"): the chooser was asked one phrase.
    expect(f.asked).toEqual(["pet me marod"]);
    expect(await rowOf("pet me marod")).toMatchObject({ kind: "complaint", conceptKey: "abdominal_pain", medicineId: null, state: "suggestion", chooserName: "jev-test-1", reviewerAnswer: null, ruleResult: "pass", refusal: null });
    expect(await rowOf("pain, chest")).toMatchObject({ conceptKey: "chest_pain", state: "suggestion", chooserName: "rule:same-words" });
    // Nothing a person mapped was written or changed.
    expect(await db.select().from(opdComplaintTerms)).toHaveLength(4);
    const ev = (await db.select().from(events)).filter((e) => e.name === "alias.run_completed");
    expect(ev[0]).toMatchObject({ payload: { kind: "complaint", proposed: 2, suggestion: 2 } });
    expect(JSON.stringify(ev[0]?.payload)).not.toMatch(/marod|chest|abdominal/);
  });

  it("BELOW THE LINE nothing changes: a proposed row nobody is shown, not asked again for 30 days", async () => {
    await used("pet me marod", 3);
    const low = fake(() => "abdominal_pain", 0.9);
    expect(await runComplaintAliasProposals(db, low.deps, CAPS, NOW)).toMatchObject({ suggestion: 0, refused: 1 });
    expect(await rowOf("pet me marod")).toMatchObject({ state: "proposed", refusal: "chooser_below_line" });
    setLearnedComplaintsOn(true);
    expect(await recognisedComplaintConcepts(db, "Pet me marod since morning", { learned: "live" })).toEqual([]);
    const again = fake();
    await runComplaintAliasProposals(db, again.deps, CAPS, new Date(NOW.getTime() + 29 * 86_400_000));
    expect(again.asked).toEqual([]);
  });

  it("a SUGGESTION is only offered as a marked chip; machines read it only once doctors' use has made it TRUSTED", async () => {
    await used("pet me marod", 3);
    await runComplaintAliasProposals(db, fake().deps, CAPS, NOW);
    const id = (await rowOf("pet me marod"))!.id;
    const sentence = "Pet me marod, 2 din se";

    // The switch off: exactly what a person mapped.
    expect(await recognisedComplaintConcepts(db, sentence, { learned: "live" })).toEqual([]);
    setLearnedComplaintsOn(true);
    expect(await recognisedComplaintConcepts(db, sentence, { learned: "live" })).toEqual([
      { conceptKey: "abdominal_pain", label: "Abdominal pain", matched: "pet me marod", alias: { id, state: "suggestion" } },
    ]);
    // Every machine reader is unchanged while it is only a suggestion.
    expect(await recognisedComplaintConcepts(db, sentence)).toEqual([]);
    expect((await conceptsForTerms(db, ["pet me marod"])).size).toBe(0);
    expect(await expandComplaintForMatching(db, "pet me marod")).toBe("pet me marod");

    const [a, b, c] = doctors as [typeof doctors[0], typeof doctors[0], typeof doctors[0]];
    for (let i = 0; i < 4; i += 1) await tap(a, id);
    for (let i = 0; i < 5; i += 1) await tap(b, id);
    expect(await rowOf("pet me marod")).toMatchObject({ state: "suggestion", taps: 9, distinctDoctors: 2 });
    await tap(c, id);
    expect(await rowOf("pet me marod")).toMatchObject({ state: "trusted", taps: 10, distinctDoctors: 3 });
    expect(await conceptsForTerms(db, ["pet me marod"])).toEqual(new Map([["pet me marod", "abdominal_pain"]]));
    expect(await expandComplaintForMatching(db, "pet me marod")).toBe("pet me marod · abdominal pain");
    expect((await recognisedComplaintConcepts(db, sentence))[0]).toMatchObject({ conceptKey: "abdominal_pain", alias: { id, state: "trusted" } });
  });

  it("three crosses by two doctors demote it; the owner's list shows it and its undo takes it back", async () => {
    await used("pet me marod", 3);
    await runComplaintAliasProposals(db, fake().deps, CAPS, NOW);
    const id = (await rowOf("pet me marod"))!.id;
    const list = await listNicknames(db, { all: true, on: true }, NOW);
    expect(list.items).toEqual([expect.objectContaining({ id, kind: "complaint", nickname: "pet me marod", medicine: "Abdominal pain", detail: null, state: "suggested" })]);
    await undoNickname(db, owner.actor, id, NOW);
    setLearnedComplaintsOn(true);
    expect(await recognisedComplaintConcepts(db, "pet me marod", { learned: "live" })).toEqual([]);

    await used("tummy ache", 2);
    await runComplaintAliasProposals(db, fake().deps, CAPS, NOW);
    const t = (await rowOf("tummy ache"))!.id;
    await tap(doctors[0]!, t, "dismissed");
    await tap(doctors[1]!, t, "dismissed");
    await tap(doctors[0]!, t, "dismissed");
    expect((await rowOf("tummy ache"))?.state).toBe("demoted");
  });

  it("the database refuses a live complaint alias with no concept, or one naming a medicine", async () => {
    const base = { kind: "complaint", term: "x y", state: "suggestion", ruleResult: "pass", createdAt: NOW, updatedAt: NOW };
    await expect(db.insert(cdsAliases).values({ id: "a1", ...base })).rejects.toThrow(/cds_aliases_live_ck/);
    await expect(db.insert(cdsAliases).values({ id: "a2", ...base, conceptKey: "fever", medicineId: "m_x" })).rejects.toThrow(/cds_aliases_target_ck/);
    await expect(db.insert(cdsAliases).values({ id: "a3", ...base, kind: "medicine", conceptKey: "fever", medicineId: "m_x", reviewerAnswer: "yes" })).rejects.toThrow(/cds_aliases_target_ck/);
  });
});
