import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdComplaintConcepts, opdComplaintTerms } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { rankSyndromes } from "../cds";
import {
  conceptsForTerms, expandComplaintForMatching, mapComplaintTerm, proposeConceptFor,
  recordComplaintUsage, suggestComplaints, unmappedComplaintTerms,
} from "./complaints";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE COMPLAINT VOCABULARY ═══
 *
 * Owner, 2026-09-14: *"how are we tackling 'chest pain', 'pain in chest', 'tight chest', 'heavy
 * chest', 'seene me dard', 'chhaati me dard'? Are we mapping different phrases with common meaning?
 * And is our system learning vocabulary of doctor?"*
 *
 * The fixture below is the SEED as the migration writes it, in miniature, so these tests state the
 * behaviour rather than depend on 118 rows landing in a particular order.
 */
const NOW = new Date("2026-08-17T04:00:00.000Z");
const AUDIT = { createdBy: "t", updatedBy: "t" };

/** Concept → its surface forms, in the three scripts the seed uses. */
const SEED: [string, string, [string, "en" | "hi" | "hinglish"][]][] = [
  ["chest_pain", "Chest pain", [
    ["chest pain", "en"], ["pain in chest", "en"], ["heavy chest", "en"], ["chest heaviness", "en"],
    ["सीने में दर्द", "hi"], ["seene me dard", "hinglish"], ["chhaati me dard", "hinglish"],
  ]],
  ["chest_tightness", "Chest tightness", [
    ["tight chest", "en"], ["chest tightness", "en"], ["seene me jakdan", "hinglish"],
  ]],
  ["cough", "Cough", [["cough", "en"], ["dry cough", "en"], ["खांसी", "hi"], ["khansi", "hinglish"]]],
  ["fever", "Fever", [["fever", "en"], ["बुखार", "hi"], ["bukhar", "hinglish"]]],
  ["dysuria", "Burning on passing urine", [
    ["dysuria", "en"], ["burning urination", "en"], ["peshab me jalan", "hinglish"],
  ]],
];

describe("the complaint vocabulary", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: m.deptId, roomId: m.roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: m.deptId, roomId: m.room2Id });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    await db.insert(opdComplaintConcepts).values(SEED.map(([key, label]) => ({ key, label, ...AUDIT })));
    await db.insert(opdComplaintTerms).values(
      SEED.flatMap(([key, , terms]) => terms.map(([term, script], i) => ({
        id: `ct_${key}_${String(i)}`, conceptKey: key, term, script, source: "seed", createdBy: "t",
      }))),
    );
  });

  /* ────────────────────────── the mapping ────────────────────────── */

  it("Q1: the owner's six phrasings of chest pain are ONE meaning", async () => {
    const phrases = ["chest pain", "pain in chest", "heavy chest", "सीने में दर्द", "seene me dard", "chhaati me dard"];
    const found = await conceptsForTerms(db, phrases);
    expect([...found.values()]).toEqual(phrases.map(() => "chest_pain"));
  });

  it("Q2: a Hindi complaint reaches an ENGLISH syndrome through its concept", async () => {
    /* `khansi` shares no letter with any syndrome keyword and never will. It arrives at URI because
       its concept's English forms are appended for the matcher — the doctor's words are untouched. */
    expect(rankSyndromes("khansi")).toEqual([]);
    const expanded = await expandComplaintForMatching(db, "khansi");
    expect(rankSyndromes(expanded).map((h) => h.key)).toContain("SYN_URI_01");
    expect(expanded.startsWith("khansi")).toBe(true);
  });

  it("Q3: the enrichment NEVER edits what was typed", async () => {
    /* The expansion is for the matcher and reaches nothing that is stored. `chief_complaint` keeps
       the doctor's string, and this is the assertion that says the enriched one is not it. */
    const expanded = await expandComplaintForMatching(db, "seene me dard");
    expect(expanded.split(" · ")[0]).toBe("seene me dard");
  });

  /**
   * ═══ THE EXPECTATION TABLE, AND WHY IT IS A TABLE RATHER THAN A DERIVED RULE ═══
   *
   * The first cut of this guard tried to derive the property — "every phrasing of a concept must
   * reach the same syndromes" — and it fired on almost every concept, because the Hindi forms reach
   * nothing on their own BY DESIGN; reaching through the concept is the whole feature.
   *
   * What a machine cannot decide is which syndromes a complaint SHOULD reach. So the judgement is
   * written down once, by a human, and the check is automatic: change a synonym and this goes red,
   * and somebody has to look at it. That is the shape this board keeps arriving at — automate the
   * check, never the judgement.
   */
  it("Q4: each concept reaches exactly the syndromes a human signed off", async () => {
    const EXPECTED: Record<string, string[]> = {
      chest_pain: [],            // no cardiac syndrome exists among the eight — see Q5
      chest_tightness: ["SYN_ASTHMA_06"],
      cough: ["SYN_URI_01"],
      fever: ["SYN_URI_01"],
      dysuria: ["SYN_UTI_08"],
    };
    for (const [key, , terms] of SEED) {
      for (const [term] of terms) {
        const expanded = await expandComplaintForMatching(db, term);
        const got = rankSyndromes(expanded).map((h) => h.key).sort();
        /* The pair is in the assertion itself: jest's `expect` takes no message argument, and a
           bare mismatch here would not say WHICH phrasing of which concept moved. */
        expect([`${key} / ${term}`, got]).toEqual([`${key} / ${term}`, [...EXPECTED[key]!].sort()]);
      }
    }
  });

  it("Q5: CHEST PAIN REACHES NO SYNDROME, and that is the correct answer", async () => {
    /*
      ═══ THE DEFECT THIS TEST EXISTS FOR ═══

      The first seed took the owner's list literally and put "chest tightness" — which is one of
      SYN_ASTHMA_06's own keywords — into `chest_pain`. Measured immediately: "chest pain" then
      reached the co-pilot's ASTHMA regimen, where before it had reached nothing. A doctor typing
      "chest pain" being offered salbutamol is the confident nonsense `matcher.ts` exists to prevent.

      Grouping phrases is a CLINICAL act, not a linguistic one. The phrasings still group for
      autocomplete and for the worklist; what they no longer do is inherit each other's syndromes.
    */
    for (const p of ["chest pain", "pain in chest", "heavy chest", "seene me dard", "सीने में दर्द"]) {
      const expanded = await expandComplaintForMatching(db, p);
      expect([p, rankSyndromes(expanded).map((h) => h.key)]).toEqual([p, []]);
    }
    /* ...while the genuine asthma symptom still does, under its own concept. */
    expect(rankSyndromes(await expandComplaintForMatching(db, "tight chest")).map((h) => h.key))
      .toEqual(["SYN_ASTHMA_06"]);
  });

  /* ────────────────────────── the learning ────────────────────────── */

  it("Q6: a phrase nobody mapped is offered back once the doctor has used it", async () => {
    /* THE VOCABULARY LEARNING, and there is no model in it. */
    expect((await suggestComplaints(db, dra.doctorId, "ghabra")).map((h) => h.term)).toEqual([]);

    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["ghabrahat ho rahi hai"], NOW));

    const after = await suggestComplaints(db, dra.doctorId, "ghabra");
    expect(after.map((h) => h.term)).toEqual(["ghabrahat ho rahi hai"]);
    expect(after[0]).toMatchObject({ conceptKey: null, mine: 1 });
  });

  it("Q7: a doctor's OWN habit outranks the hospital's", async () => {
    await withTx(db, async (tx) => {
      for (let i = 0; i < 5; i += 1) await recordComplaintUsage(tx, drb.doctorId, ["cough"], NOW);
      await recordComplaintUsage(tx, dra.doctorId, ["dry cough"], NOW);
    });
    /*
      A complaint field is a personal shorthand before it is a shared vocabulary: A wrote "dry
      cough" once, B wrote "cough" five times, and each sees their own first.

      The query is PARTIAL on purpose. Typing `cough` in full and being offered `cough` first is
      correct whoever you are, so an exact match is ranked above habit and this test would have been
      measuring that instead — it did, on the first run.
    */
    expect((await suggestComplaints(db, dra.doctorId, "cou"))[0]!.term).toBe("dry cough");
    expect((await suggestComplaints(db, drb.doctorId, "cou"))[0]!.term).toBe("cough");
  });

  it("Q8: one encounter counts a repeated phrase ONCE", async () => {
    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["fever", "Fever", " fever "], NOW));
    const hits = await suggestComplaints(db, dra.doctorId, "fever");
    expect(hits.find((h) => h.term === "fever")!.mine).toBe(1);
  });

  /* ────────────────────────── the worklist ────────────────────────── */

  it("Q9: the unmapped worklist is what the hospital types and nobody has mapped", async () => {
    await withTx(db, async (tx) => {
      for (let i = 0; i < 3; i += 1) await recordComplaintUsage(tx, dra.doctorId, ["ghabrahat"], NOW);
      await recordComplaintUsage(tx, drb.doctorId, ["ghabrahat"], NOW);
      await recordComplaintUsage(tx, dra.doctorId, ["kamzori"], NOW);
      /* A MAPPED phrase is not work — it must not appear however often it is used. */
      for (let i = 0; i < 9; i += 1) await recordComplaintUsage(tx, dra.doctorId, ["cough"], NOW);
    });

    const work = await unmappedComplaintTerms(db);
    expect(work.map((w) => [w.term, w.uses])).toEqual([["ghabrahat", 4], ["kamzori", 1]]);
    expect(work.map((w) => w.term)).not.toContain("cough");
  });

  it("Q10: mapping a phrase takes it off the worklist and into the vocabulary", async () => {
    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["chaati me dard"], NOW));
    expect((await unmappedComplaintTerms(db)).map((w) => w.term)).toContain("chaati me dard");

    await withTx(db, (tx) => mapComplaintTerm(tx, clerk.actor, "chaati me dard", "chest_pain", "hinglish"));

    expect((await unmappedComplaintTerms(db)).map((w) => w.term)).not.toContain("chaati me dard");
    expect((await conceptsForTerms(db, ["chaati me dard"])).get("chaati me dard")).toBe("chest_pain");
  });

  it("Q11: a mapping is recorded as a HUMAN's, and refuses an unknown concept", async () => {
    await expect(withTx(db, (tx) => mapComplaintTerm(tx, clerk.actor, "x", "no_such_concept", "en")))
      .rejects.toThrow(/unknown concept/);

    await withTx(db, (tx) => mapComplaintTerm(tx, clerk.actor, "gala pak gaya", "cough", "hinglish"));
    const [row] = await db.select().from(opdComplaintTerms).where(eq(opdComplaintTerms.term, "gala pak gaya"));
    /* `mapped`, never `proposed`: the table cannot represent a machine's opinion as a fact. */
    expect(row).toMatchObject({ source: "mapped", createdBy: clerk.actor.id });
  });

  /* ────────────────────────── the proposer ────────────────────────── */

  it("Q12: the proposer reaches a spelling nobody seeded — locally, and it only PROPOSES", async () => {
    /*
      `kernel/inference/types.ts` is this tree's one choke point for outbound AI and defers the
      text-completion half to Plan 12a. So this proposes with pg_trgm and a shared-word test on the
      box: no model, no outbound call, and no patient phrase leaving the machine.
    */
    const p = await proposeConceptFor(db, "pishab me jalan");
    expect(p[0]!.conceptKey).toBe("dysuria");

    /* Proposing changes NOTHING until a human maps it. */
    expect((await conceptsForTerms(db, ["pishab me jalan"])).size).toBe(0);
  });

  it("Q13: the proposer offers nothing rather than a bad guess", async () => {
    expect(await proposeConceptFor(db, "")).toEqual([]);
    expect(await proposeConceptFor(db, "zzzqqq")).toEqual([]);
  });
});
