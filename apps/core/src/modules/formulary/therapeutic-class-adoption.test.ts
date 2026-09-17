import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { THERAPEUTIC_CLASS_BOOK_2026_09_17 } from "../../../scripts/data/therapeutic-classes-2026-09-17";
import { withTx } from "../../kernel/db/client";
import { events, formularySalts, formularySubstances } from "../../kernel/db/schema";
import { addSalt } from "./masters";
import { THERAPEUTIC_DUPLICATE_CLASSES, adoptTherapeuticClasses } from "./therapeutic-classes";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TherapeuticClassEntry } from "./therapeutic-classes";

/**
 * ═══ FORMULARY P23 — THERAPEUTIC CLASSES ADOPTED FROM THE CLINICAL MASTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p23-duplicate-classes.md`.
 */
const CURATOR: Actor = { type: "user", id: "01HCURATOR0000000000000001" };
const RESOLUTION = "owner-resolution-2026-09-17-therapeutic-classes";

describe("adopting therapeutic classes by resolution (P23)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const salt = (name: string, drugClass: string | null = null) =>
    withTx(db, (tx) => addSalt(tx, CURATOR, { name, drugClass })).then((r) => r.saltId);
  const adopt = (book: readonly TherapeuticClassEntry[], actor: Actor = CURATOR) =>
    withTx(db, (tx) => adoptTherapeuticClasses(tx, actor, RESOLUTION, book));
  const classOf = async (id: string): Promise<string | null> =>
    (await db.select({ c: formularySalts.drugClass }).from(formularySalts).where(eq(formularySalts.id, id)))[0]!.c;

  it("sets the class where none is recorded, keeps one a curator set, reports a different one, and waits for a name that is not a moiety", async () => {
    const pan = await salt("Pantoprazole");
    const ome = await salt("omeprazole", "ppi");
    const rab = await salt("rabeprazole", "antacid");
    const pending = newId();
    await db.insert(formularySalts).values({ id: pending, name: "Esomeprazole", sourceRef: "SCT-ESO", createdBy: CURATOR.id, updatedBy: CURATOR.id });
    await db.insert(formularySubstances).values({ id: newId(), sctid: "SCT-ESO", name: "Esomeprazole", mappingStatus: "pending", source: "nrces-2026-09", createdBy: CURATOR.id, updatedBy: CURATOR.id });

    const book: TherapeuticClassEntry[] = [{
      drugClass: "ppi", rule: "therapeutic_subclass_groups#SUB_PPI",
      moieties: ["pantoprazole", "omeprazole", "rabeprazole", "esomeprazole", "lansoprazole"],
    }];
    expect(await adopt(book)).toEqual({
      resolution: RESOLUTION, assigned: 1, alreadyRecorded: 1,
      conflicts: [{ name: "rabeprazole", current: "antacid", wanted: "ppi" }],
      missing: [{ name: "esomeprazole", drugClass: "ppi" }, { name: "lansoprazole", drugClass: "ppi" }],
    });
    expect([await classOf(pan), await classOf(ome), await classOf(rab), await classOf(pending)]).toEqual(["ppi", "ppi", "antacid", null]);
    const adopted = await db.select().from(events).where(eq(events.name, "salt.therapeutic_class_adopted"));
    expect(adopted.map((e) => e.payload)).toEqual([
      { saltId: pan, drugClass: "ppi", source: `resolution:${RESOLUTION} (therapeutic_subclass_groups#SUB_PPI)` },
    ]);
    // Idempotent: nothing more to do.
    expect(await adopt(book)).toMatchObject({ assigned: 0, alreadyRecorded: 2 });
  });

  it("is a person's act, and refuses a malformed book before writing anything", async () => {
    const pan = await salt("pantoprazole");
    const good: TherapeuticClassEntry = { drugClass: "ppi", rule: "r#1", moieties: ["pantoprazole"] };
    await expect(adopt([good], { type: "system", id: "seed" })).rejects.toMatchObject({ code: "attester_not_user" });
    await expect(adopt([{ ...good, drugClass: "antacid" }])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([good, { ...good, drugClass: "statin" }])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([{ ...good, rule: "" }])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(withTx(db, (tx) => adoptTherapeuticClasses(tx, CURATOR, " ", [good]))).rejects.toMatchObject({ code: "invalid_adoption" });
    expect(await classOf(pan)).toBeNull();
  });

  it("the 2026-09-17 book: the clinical master's five groups, completed, with no moiety in two", () => {
    const book = THERAPEUTIC_CLASS_BOOK_2026_09_17;
    expect(book.map((e) => e.drugClass).sort()).toEqual([...THERAPEUTIC_DUPLICATE_CLASSES].sort());
    const all = book.flatMap((e) => e.moieties);
    expect(new Set(all).size).toBe(all.length);
    const members = (c: string): readonly string[] => book.find((e) => e.drugClass === c)?.moieties ?? [];
    // The source's own members are all there.
    expect(members("ppi")).toEqual(expect.arrayContaining(["pantoprazole", "omeprazole", "rabeprazole", "esomeprazole", "lansoprazole"]));
    expect(members("arb")).toEqual(expect.arrayContaining(["telmisartan", "losartan", "olmesartan", "candesartan", "valsartan"]));
    // Coxibs duplicate a non-selective NSAID; aspirin keeps its class but is not flagged (rx-checks).
    expect(members("nsaid")).toEqual(expect.arrayContaining(["etoricoxib", "celecoxib", "diclofenac", "aceclofenac"]));
    // Flupirtine is not an NSAID.
    expect(all).not.toContain("flupirtine");
    expect(all.filter((n) => n !== n.toLowerCase().trim())).toEqual([]);
  });
});
