import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ALLERGY_CLASS_BOOK_2026_09_17 } from "../../../scripts/data/allergy-classes-2026-09-17";
import { withTx } from "../../kernel/db/client";
import { events, formularySalts, formularySubstances } from "../../kernel/db/schema";
import { ALLERGY_CLASSES, adoptAllergyClasses, allergyClassKeys } from "./allergy-classes";
import { addSalt, updateSalt } from "./masters";
import { resolveDrugTexts } from "./resolve";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AllergyClassEntry } from "./allergy-classes";

/**
 * ═══ FORMULARY P22 — ALLERGY CLASSES ADOPTED FROM THE CLINICAL MASTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p22-allergy-classes.md`.
 */
const CURATOR: Actor = { type: "user", id: "01HCURATOR0000000000000001" };
const RESOLUTION = "owner-resolution-2026-09-17-allergy-classes";

describe("adopting allergy classes by resolution (P22)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const salt = (name: string) => withTx(db, (tx) => addSalt(tx, CURATOR, { name })).then((r) => r.saltId);
  const adopt = (book: readonly AllergyClassEntry[], actor: Actor = CURATOR, resolution = RESOLUTION) =>
    withTx(db, (tx) => adoptAllergyClasses(tx, actor, resolution, book));
  const classesOf = async (id: string): Promise<string[]> =>
    (await db.select({ c: formularySalts.allergyClasses }).from(formularySalts).where(eq(formularySalts.id, id)))[0]!.c;

  it("adds a class to each named moiety under the resolution, keeps what a curator set, and waits for a name that is not a moiety yet", async () => {
    const amox = await salt("Amoxicillin");
    const cefalexin = await salt("cefalexin");
    // A curator already put cefalexin in a class of their own: the resolution adds, never replaces.
    await withTx(db, (tx) => updateSalt(tx, CURATOR, cefalexin, { allergyClasses: ["cephalosporin"] }));
    // A release entry nobody has decided is not a moiety yet.
    const pending = newId();
    await db.insert(formularySalts).values({ id: pending, name: "Ampicillin", sourceRef: "SCT-AMP", createdBy: CURATOR.id, updatedBy: CURATOR.id });
    await db.insert(formularySubstances).values({ id: newId(), sctid: "SCT-AMP", name: "Ampicillin", mappingStatus: "pending", source: "nrces-2026-09", createdBy: CURATOR.id, updatedBy: CURATOR.id });

    const book: AllergyClassEntry[] = [{
      classKey: "penicillin", rule: "allergy_cross_reactivity_rules#1",
      moieties: ["amoxicillin", "ampicillin", "cefalexin", "piperacillin"],
    }];
    const report = await adopt(book);

    expect(report).toEqual({
      resolution: RESOLUTION, assigned: 2, alreadyRecorded: 0,
      missing: [{ name: "ampicillin", classKey: "penicillin" }, { name: "piperacillin", classKey: "penicillin" }],
    });
    expect(await classesOf(amox)).toEqual(["penicillin"]);
    expect(await classesOf(cefalexin)).toEqual(["cephalosporin", "penicillin"]);
    expect(await classesOf(pending)).toEqual([]);
    const adopted = await db.select().from(events).where(eq(events.name, "salt.allergy_classes_adopted"));
    expect(adopted.map((e) => e.payload)).toEqual(expect.arrayContaining([
      { saltId: amox, added: ["penicillin"], allergyClasses: ["penicillin"], source: `resolution:${RESOLUTION} (allergy_cross_reactivity_rules#1)` },
    ]));
    expect(adopted).toHaveLength(2);

    // What the check reads: the moiety's classes travel with its resolution.
    const resolved = await resolveDrugTexts(db, ["amoxicillin"]);
    expect(resolved.get("amoxicillin")?.salts).toEqual([expect.objectContaining({ saltId: amox, allergyClasses: ["penicillin"] })]);

    // Decided later: the same adoption, run again, adds only what is now a moiety.
    await db.update(formularySubstances).set({ mappingStatus: "mapped", saltId: pending, mappedBy: CURATOR.id, mappedAt: new Date() }).where(eq(formularySubstances.sctid, "SCT-AMP"));
    expect(await adopt(book)).toMatchObject({ assigned: 1, alreadyRecorded: 2, missing: [{ name: "piperacillin" }] });
    expect(await classesOf(pending)).toEqual(["penicillin"]);
  });

  it("is a person's act under a named resolution, and refuses a malformed book before writing anything", async () => {
    const amox = await salt("amoxicillin");
    const good: AllergyClassEntry = { classKey: "penicillin", rule: "r#1", moieties: ["amoxicillin"] };
    await expect(adopt([good], { type: "system", id: "seed" })).rejects.toMatchObject({ code: "attester_not_user" });
    await expect(adopt([good], CURATOR, " ")).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([{ ...good, classKey: "beta_lactam" }])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([{ ...good, moieties: ["amoxicillin", "Amoxicillin"] }])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([{ ...good, rule: " " }])).rejects.toMatchObject({ code: "invalid_adoption" });
    expect(await classesOf(amox)).toEqual([]);
    // A curator may only name a class the check knows.
    await expect(withTx(db, (tx) => updateSalt(tx, CURATOR, amox, { allergyClasses: ["penicilin"] }))).rejects.toMatchObject({ code: "invalid_allergy_class" });
  });

  it("the 2026-09-17 book: the clinical master's six classes, corrected where the reference over-reached", () => {
    const book = ALLERGY_CLASS_BOOK_2026_09_17;
    const members = (key: string): string[] => book.filter((e) => e.classKey === key).flatMap((e) => e.moieties);
    expect(book.map((e) => e.classKey).sort()).toEqual(Object.keys(ALLERGY_CLASSES).sort());
    // Same-side-chain cephalosporins are in; a later-generation one is not.
    expect(members("penicillin")).toEqual(expect.arrayContaining(["amoxicillin", "cefalexin", "cefadroxil"]));
    expect(members("penicillin")).not.toContain("cefuroxime");
    // Non-antibiotic sulfonamides do not cross-react (the reference listed them).
    for (const n of ["furosemide", "hydrochlorothiazide", "celecoxib"]) expect(members("sulfonamide_antibiotic")).not.toContain(n);
    // Opioids from other structural classes are the alternatives, not members (the reference listed them).
    for (const n of ["fentanyl", "pethidine", "tramadol"]) expect(members("opioid_morphinan")).not.toContain(n);
    expect(members("opioid_morphinan")).toEqual(expect.arrayContaining(["morphine", "codeine"]));
    // Selective COX-2 inhibitors are what an AERD patient is offered instead.
    for (const n of ["etoricoxib", "celecoxib"]) expect(members("nsaid")).not.toContain(n);
    // Amide local anaesthetics are the alternative to the esters.
    expect(members("ester_local_anaesthetic")).not.toContain("lidocaine");
    // Every name is spelled as the national release spells its moiety, and appears once per class.
    for (const e of book) expect(new Set(e.moieties).size).toBe(e.moieties.length);
    expect(book.flatMap((e) => e.moieties).filter((n) => n !== n.toLowerCase().trim())).toEqual([]);
  });

  it("the vocabulary: the picker's class names and the words a doctor types reach one key each", () => {
    expect(allergyClassKeys("Penicillins / Beta-Lactams", "Penicillins / Beta-Lactams")).toEqual(["penicillin"]);
    expect(allergyClassKeys("Sulpha drugs", null)).toEqual(["sulfonamide_antibiotic"]);
    expect(allergyClassKeys("anything", "NSAIDs / Aspirin (AERD)")).toEqual(["nsaid"]);
    expect(allergyClassKeys("Latex", "Latex")).toEqual([]);
    expect(allergyClassKeys("penicillin rash as a child", null)).toEqual([]);
  });
});
