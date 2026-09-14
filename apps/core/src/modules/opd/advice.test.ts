import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { opdAdviceTemplates } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { KEYWORD_LEAD, listAdviceTemplates, retireAdviceTemplate, saveAdviceTemplate } from "./advice";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE ADVICE LIBRARY — THE ONE FIELD THE PATIENT READS ═══
 *
 * Owner's own idea, 2026-09-14, and two rulings shape it: a shared library with the doctor's own
 * favourites floated to the top, and the doctor choosing the LANGUAGE per template.
 *
 * Everything below is about WHOSE row a template is and WHICH SCRIPT reaches the patient. There is
 * no patient data here at all — a template is the doctor's words about a condition, not a person.
 */
const NOW = new Date("2026-08-17T04:00:00.000Z");

describe("the advice library", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkUser>>;
  let drb: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    dra = await mkUser(db, "dra", ["doctor"]);
    drb = await mkUser(db, "drb", ["doctor"]);
    /* The hospital's own row, as the migration seeds it: owner NULL, both scripts. */
    await db.insert(opdAdviceTemplates).values({
      id: "adv_shared", ownerUserId: null, title: "Rest and fluids",
      textEn: "Take rest. Drink plenty of fluids.",
      textHi: "आराम करें। खूब तरल पिएं।",
      createdBy: "system-seed", updatedBy: "system-seed",
    });
  });

  it("V1: a doctor sees the hospital's library on day one, having saved nothing", async () => {
    /* The reason a per-doctor-only design was rejected: the list would be empty here. */
    const items = await listAdviceTemplates(db, dra.actor);
    expect(items.map((i) => i.title)).toEqual(["Rest and fluids"]);
    expect(items[0]).toMatchObject({ mine: false, textHi: "आराम करें। खूब तरल पिएं।" });
  });

  it("V2: the doctor's OWN float above the hospital's", async () => {
    await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      title: "Zzz last alphabetically", textEn: "Mine.", textHi: "मेरा।",
    }, NOW));

    const items = await listAdviceTemplates(db, dra.actor);
    // Sorted in SQL, not in a browser — every reader of this list agrees about its order.
    expect(items.map((i) => [i.title, i.mine])).toEqual([
      ["Zzz last alphabetically", true],
      ["Rest and fluids", false],
    ]);
  });

  it("V3: one doctor's favourites are not another's", async () => {
    await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "A's own", textEn: "Mine." }, NOW));

    expect((await listAdviceTemplates(db, drb.actor)).map((i) => i.title)).toEqual(["Rest and fluids"]);
    expect((await listAdviceTemplates(db, dra.actor)).map((i) => i.title)).toEqual(["A's own", "Rest and fluids"]);
  });

  it("V4: the owner comes from the ACTOR, so a body cannot write into someone else's library", async () => {
    await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      /* There is no owner field to send; this is the shape of the attempt if there were. */
      title: "Planted", textEn: "Not yours.",
    } as { title: string; textEn: string }, NOW));

    const rows = await db.select().from(opdAdviceTemplates).where(eq(opdAdviceTemplates.title, "Planted"));
    expect(rows[0]!.ownerUserId).toBe(dra.actor.id);
  });

  it("V5: either script may be missing — half a row beats no row", async () => {
    await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "English only", textEn: "Only this." }, NOW));
    const mine = (await listAdviceTemplates(db, dra.actor)).find((i) => i.title === "English only");
    // The field offers one button instead of two; nothing anywhere translates it at print time.
    expect(mine!.textHi).toBeNull();
  });

  it("V6: a template with no text in EITHER script is refused; one script is enough", async () => {
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "  ", textEn: "x" }, NOW)))
      .rejects.toThrow(/advice_template_incomplete|a template needs/);
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "x", textEn: "   ", textHi: "  " }, NOW)))
      .rejects.toThrow(/advice_template_incomplete|a template needs/);
    /* One script IS enough, and it may be Hindi. The first cut of this table had `text_en NOT
       NULL`, which would have filed a doctor's Hindi advice under an English button. */
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      title: "हिंदी में", textHi: "खूब पानी पिएं।",
    }, NOW))).resolves.toBeDefined();
    const hiOnly = (await listAdviceTemplates(db, dra.actor)).find((i) => i.title === "हिंदी में");
    expect(hiOnly).toMatchObject({ textEn: null, textHi: "खूब पानी पिएं।" });
  });

  it("V9: a keyword that could fire INSIDE A WORD is refused", async () => {
    /*
      Expansion runs while the doctor types. `rest` would detonate in the middle of "rest and
      fluids", "arrest" and "restrict", replacing prose the doctor was halfway through writing. The
      browser checks this too; this is the check that holds when a body is posted without it.
    */
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      title: "Rest", keyword: "rest", textEn: "Take rest.",
    }, NOW))).rejects.toThrow(/advice_keyword_invalid|start with/);

    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      title: "Rest", keyword: ";two words", textEn: "Take rest.",
    }, NOW))).rejects.toThrow(/advice_keyword_invalid|space/);

    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      title: "Rest", keyword: ";", textEn: "Take rest.",
    }, NOW))).rejects.toThrow(/advice_keyword_invalid|character after/);

    /* Each permitted lead character works, and no keyword at all stays legal. */
    for (const lead of KEYWORD_LEAD) {
      await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
        title: `ok ${lead}`, keyword: `${lead}ok`, textEn: "x",
      }, NOW))).resolves.toBeDefined();
    }
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, {
      title: "Tapped only", textEn: "x",
    }, NOW))).resolves.toBeDefined();
  });

  it("V10: one keyword per doctor, case-folded — two would be a coin toss", async () => {
    await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "A", keyword: ";uri", textEn: "x" }, NOW));

    /* A doctor with two `;uri` snippets never finds out which one expanded. */
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "B", keyword: ";URI", textEn: "y" }, NOW)))
      .rejects.toThrow();

    /* ...but ANOTHER doctor's library is their own, and the same keyword there is no collision. */
    await expect(withTx(db, (tx) => saveAdviceTemplate(tx, drb.actor, { title: "B", keyword: ";uri", textEn: "y" }, NOW)))
      .resolves.toBeDefined();
  });

  it("V11: the keyword comes back on the list, so the field knows what to watch for", async () => {
    await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "Rest", keyword: ";rest", textEn: "Take rest." }, NOW));
    const mine = (await listAdviceTemplates(db, dra.actor)).find((i) => i.title === "Rest");
    expect(mine!.keyword).toBe(";rest");
    /* The hospital's seeded rows are TAPPED, not typed — no keyword, and that is not a defect. */
    expect((await listAdviceTemplates(db, dra.actor)).find((i) => i.title === "Rest and fluids")!.keyword).toBeNull();
  });

  it("V7: retiring DEACTIVATES — the row that printed on a slip last week still explains it", async () => {
    const { templateId } = await withTx(db, (tx) => saveAdviceTemplate(tx, dra.actor, { title: "Temp", textEn: "x" }, NOW));
    await withTx(db, (tx) => retireAdviceTemplate(tx, dra.actor, templateId, NOW));

    expect((await listAdviceTemplates(db, dra.actor)).map((i) => i.title)).toEqual(["Rest and fluids"]);
    const rows = await db.select().from(opdAdviceTemplates).where(eq(opdAdviceTemplates.id, templateId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
  });

  it("V8: a doctor cannot retire the HOSPITAL'S row, nor another doctor's", async () => {
    /* One seat removing an entry every other doctor uses is the failure mode a shared surface has. */
    await expect(withTx(db, (tx) => retireAdviceTemplate(tx, dra.actor, "adv_shared", NOW)))
      .rejects.toThrow(/unknown_advice_template|no template of your own/);

    const { templateId } = await withTx(db, (tx) => saveAdviceTemplate(tx, drb.actor, { title: "B's", textEn: "x" }, NOW));
    // Not-found and not-yours answer identically, so an id cannot be used to probe whose row it is.
    await expect(withTx(db, (tx) => retireAdviceTemplate(tx, dra.actor, templateId, NOW)))
      .rejects.toThrow(/unknown_advice_template|no template of your own/);

    expect((await db.select().from(opdAdviceTemplates).where(eq(opdAdviceTemplates.id, "adv_shared")))[0]!.active).toBe(true);
  });
});
