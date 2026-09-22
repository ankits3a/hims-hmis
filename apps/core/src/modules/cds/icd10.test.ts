import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { icd10Codes } from "../../kernel/db/schema";
import { generalityOf } from "../../../scripts/import-icd10-catalogue";
import { MIN_QUERY_CHARS, searchIcd10 } from "./icd10";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE DIAGNOSIS TYPEAHEAD ═══
 *
 * Every fixture here is a REAL row from the ICD-10-CM tabular list, with its real code, real
 * description and real chapter — and `generality` is computed by the loader's own function rather
 * than typed in, so a fixture cannot quietly disagree with what the importer would have written.
 *
 * The pairs were chosen from measurements against the whole 97,296-row catalogue. Each one ranked
 * the WRONG way round at some point while this was being built, and the comment on each test says
 * which draft it caught.
 */
const R = (
  code: string, order: number, billable: boolean, desc: string, chapterNo: number,
): typeof icd10Codes.$inferInsert => ({
  code, rawCode: code.replace(".", ""), orderNumber: order, billable,
  shortDescription: desc, longDescription: desc,
  chapterNo, chapterName: `Chapter ${String(chapterNo)}: …`,
  generality: generalityOf(code, desc),
});

describe("searchIcd10 — the diagnosis the desk actually assigns", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seed(): Promise<void> {
    await db.insert(icd10Codes).values([
      // ASTHMA — the residual code against four severity-qualified siblings.
      R("J45.909", 40001, true, "Unspecified asthma, uncomplicated", 10),
      R("J45.20", 40002, true, "Mild intermittent asthma, uncomplicated", 10),
      R("J45.998", 40003, true, "Other asthma", 10),
      // A CATEGORY HEADER — never assignable, and it must never be offered.
      R("J45", 40000, false, "Asthma", 10),
      // FEVER
      R("R50.9", 50001, true, "Fever, unspecified", 18),
      // THE FRACTURE AND ITS EPISODES — one injury, five codes.
      R("S02.109A", 60001, true, "Fracture of base of skull, unspecified side, init", 19),
      R("S02.109B", 60002, true, "Fracture of base of skull, unspecified side, 7thB", 19),
      R("S02.109D", 60003, true, "Fracture of base of skull, unspecified side, 7thD", 19),
      R("S02.129A", 60010, true, "Fracture of orbital roof, unspecified side, init", 19),
      // EXTERNAL CAUSE — chapter 20, how it happened, never a diagnosis.
      R("W01.0XXA", 70001, true, "Fall on same level from slipping, initial encounter", 20),
      // THE CODE BRANCH
      R("J06.9", 30001, true, "Acute upper respiratory infection, unspecified", 10),
      R("J06.0", 30000, true, "Acute laryngopharyngitis", 10),
    ]);
  }

  it("I1: the residual code beats its severity-qualified siblings", async () => {
    await seed();
    // MEASURED WRONG TWICE. Ranked on description length, "Other asthma" won; ranked with
    // `uncomplicated` and `unspecified` scored equally, "Mild intermittent asthma" won.
    const hits = await searchIcd10(db, "asthma");
    expect(hits[0]!.code).toBe("J45.909");
  });

  it("I2: a category header is never offered, however exactly it matches", async () => {
    await seed();
    const hits = await searchIcd10(db, "asthma");
    // `J45` is literally named "Asthma" and would win every text test there is. It is not
    // assignable to an encounter or a claim, so the desk must never be handed it.
    expect(hits.map((h) => h.code)).not.toContain("J45");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("I3: one injury does not spend the whole list on its encounter episodes", async () => {
    await seed();
    const hits = await searchIcd10(db, "fracture of", 3);
    // The initial encounter is what an OPD writes; B and D are follow-ups of the SAME fracture and
    // must sit below a DIFFERENT fracture. Measured on the real catalogue, five of ten rows were
    // S02.109 A/B/D/G/K before the 7th character was read.
    expect(hits.map((h) => h.code)).toEqual(["S02.109A", "S02.129A", "S02.109B"]);
  });

  it("I4: an external-cause code sorts below a real diagnosis", async () => {
    await seed();
    const hits = await searchIcd10(db, "initial");
    expect(hits[hits.length - 1]!.code).toBe("W01.0XXA");
  });

  it("I5: typing a CODE reaches it, and says so", async () => {
    await seed();
    const hits = await searchIcd10(db, "j06.9");
    expect(hits[0]).toMatchObject({ code: "J06.9", codeMatch: true });
  });

  it("I6: a code prefix reaches every child, the general one first", async () => {
    await seed();
    const hits = await searchIcd10(db, "j06");
    expect(hits.map((h) => h.code)).toEqual(["J06.9", "J06.0"]);
  });

  it("I7: prose reaches the code, and that hit is not marked as a code match", async () => {
    await seed();
    const hits = await searchIcd10(db, "fever");
    expect(hits[0]).toMatchObject({ code: "R50.9", codeMatch: false });
  });

  it("I8: under two characters it answers nothing rather than everything", async () => {
    await seed();
    expect(MIN_QUERY_CHARS).toBe(2);
    expect(await searchIcd10(db, "j")).toEqual([]);
    expect(await searchIcd10(db, "  ")).toEqual([]);
  });

  it("I9: the limit is capped, so a caller cannot ask for the catalogue", async () => {
    await seed();
    expect((await searchIcd10(db, "a", 999)).length).toBeLessThanOrEqual(25);
    expect((await searchIcd10(db, "fracture", 999)).length).toBeLessThanOrEqual(25);
  });
});
