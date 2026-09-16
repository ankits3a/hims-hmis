import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularySubstances } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import {
  attestSubstance, pageMappingWorklist, projectSubstances, refreshRankSignals, ruleSubstanceUnmappable,
  writeProposals,
} from "./mapping";
import { addMedicine, addSalt, updateSalt } from "./masters";
import { catalogueCensus, pageSalts } from "./reads";
import { normalizeDrugName } from "./resolve";
import { searchMedicines } from "./search";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AttestTarget } from "./mapping";

/**
 * ═══ THE MAPPING LOOP: A DRAFTER PROPOSES, A PHARMACIST ATTESTS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase2-formulary-mapping-loop.md`; the E-numbers
 * below are its edge-case register.
 *
 * The release tier and the catalogue are written the way the two importers write them, as raw rows
 * (`import-nrces-formulary.ts` and `import-cds-catalogue.ts` insert directly, with no events). The
 * curated half goes through `addSalt`, as the seed does. Every substance id is the release's real
 * SNOMED CT id, and every fixture is a true statement: Augmentin IS amoxicillin trihydrate +
 * clavulanate potassium; Calcium Sandoz IS calcium glubionate + calcium lactobionate. A suite that is
 * green over invented pharmacology proves the plumbing and nothing else.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const COLLEAGUE: Actor = { type: "user", id: "01HPHARMACIST0000000000002" };

const SCT = {
  amoxTrihydrate: "96068000",
  clavulanate: "395938000",
  warfarinSodium: "63167009",
  paracetamol: "387517004",
  diclofenac: "7034005",
  diclofenacSodium: "62039007",
  calciumGlubionate: "32445001",
  calciumLactobionate: "395935002",
  lactobacillus: "710318008",
} as const;

describe("the formulary mapping loop (phase 2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  // ─────────────────────────────── fixtures ───────────────────────────────

  /** A release substance, and (unless `image` is null) the catalogue importer's verbatim copy of it. */
  async function releaseSubstance(sctid: string, released: string, image: string | null): Promise<{ id: string; image: string }> {
    const id = newId();
    await db.execute(sql`
      insert into formulary_substances (id, sctid, name, synonyms, mapping_status, source, created_by, updated_by)
      values (${id}, ${sctid}, ${released}, '[]'::jsonb, 'pending', 'nrces-2026-09', 'nrces-test', 'nrces-test')
    `);
    const imageId = newId();
    if (image !== null) {
      await db.execute(sql`
        insert into formulary_salts (id, name, aliases, source_ref, created_by, updated_by)
        values (${imageId}, ${image}, '[]'::jsonb, ${sctid}, 'cds-import', 'cds-import')
      `);
    }
    return { id, image: imageId };
  }

  /** A catalogue product whose every row is derived from a release substance, as the importer writes it. */
  async function catalogueProduct(brand: string, parts: { salt: string; sctid: string; strength?: string }[]): Promise<string> {
    const id = newId();
    await db.execute(sql`
      insert into formulary_medicines (id, brand_name, name_normalized, form, route_class, source_ref, created_by, updated_by)
      values (${id}, ${brand}, ${normalizeDrugName(brand)}, 'tablet', 'systemic', ${`brand:${id}`}, 'cds-import', 'cds-import')
    `);
    for (const p of parts) {
      await db.execute(sql`
        insert into formulary_medicine_salts (medicine_id, salt_id, strength, source, derived_from)
        values (${id}, ${p.salt}, ${p.strength ?? null}, 'derived', ${p.sctid})
      `);
    }
    return id;
  }

  async function composition(medicineId: string): Promise<{ saltId: string; source: string; derivedFrom: string | null }[]> {
    const r = await db.execute<{ salt_id: string; source: string; derived_from: string | null }>(sql`
      select salt_id, source, derived_from from formulary_medicine_salts where medicine_id = ${medicineId} order by salt_id
    `);
    if (r.rows.length === 0) throw new Error(`medicine ${medicineId} has no composition at all`);
    return r.rows.map((x) => ({ saltId: x.salt_id, source: x.source, derivedFrom: x.derived_from }));
  }

  const saltsOf = async (medicineId: string): Promise<string[]> => (await composition(medicineId)).map((c) => c.saltId).sort();

  async function substance(id: string): Promise<typeof formularySubstances.$inferSelect> {
    const rows = await db.select().from(formularySubstances).where(eq(formularySubstances.id, id));
    if (rows[0] === undefined) throw new Error(`no substance ${id}`);
    return rows[0];
  }

  async function payloads(name: string): Promise<Record<string, unknown>[]> {
    const rows = await db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  async function productCount(saltId: string): Promise<number> {
    const r = await db.execute<{ n: number }>(sql`select product_count as n from formulary_salts where id = ${saltId}`);
    return Number(r.rows[0]?.n);
  }

  const moiety = async (name: string, drugClass?: string): Promise<string> =>
    (await withTx(db, (tx) => addSalt(tx, PHARMACIST, drugClass === undefined ? { name } : { name, drugClass }))).saltId;

  const attest = (actor: Actor, substanceId: string, target: AttestTarget, opts?: Parameters<typeof attestSubstance>[4]) =>
    withTx(db, (tx) => attestSubstance(tx, actor, substanceId, target, opts));

  async function refusal(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof FormularyError) return e.code;
      throw e;
    }
    throw new Error("expected a refusal and the call succeeded");
  }

  /** Augmentin, as the catalogue importer leaves it: both rows on release images. */
  async function augmentinWorld(): Promise<{
    amox: string; amoxTri: { id: string; image: string }; clav: { id: string; image: string };
    augmentin: string; mox: string;
  }> {
    const amox = await moiety("amoxicillin", "penicillin");
    const amoxTri = await releaseSubstance(SCT.amoxTrihydrate, "Amoxicillin trihydrate (substance)", "Amoxicillin trihydrate");
    const clav = await releaseSubstance(SCT.clavulanate, "Clavulanate potassium (substance)", "Clavulanate potassium");
    const augmentin = await catalogueProduct("Augmentin 625 Duo", [
      { salt: amoxTri.image, sctid: SCT.amoxTrihydrate, strength: "500 mg" },
      { salt: clav.image, sctid: SCT.clavulanate, strength: "125 mg" },
    ]);
    const mox = await catalogueProduct("Mox 250 Kid", [{ salt: amoxTri.image, sctid: SCT.amoxTrihydrate, strength: "250 mg" }]);
    await withTx(db, (tx) => refreshRankSignals(tx, "all"));
    return { amox, amoxTri, clav, augmentin, mox };
  }

  // ─────────────────────────────── who may decide ───────────────────────────────

  describe("only a person attests (E9)", () => {
    it.each(["agent", "system", "patient"] as const)("refuses a %s actor before anything is written", async (type) => {
      const { amox, amoxTri, mox } = await augmentinWorld();
      const actor: Actor = { type, id: "01HNOTAPERSON0000000000001" };

      expect(await refusal(attest(actor, amoxTri.id, { saltId: amox }))).toBe("attester_not_user");
      expect(await refusal(withTx(db, (tx) => ruleSubstanceUnmappable(tx, actor, amoxTri.id, { reason: "x" }))))
        .toBe("attester_not_user");

      expect((await substance(amoxTri.id)).mappingStatus).toBe("pending");
      expect(await saltsOf(mox)).toEqual([amoxTri.image]);
      expect(await payloads("substance.mapped")).toHaveLength(0);
    });

    /** The gate runs before the read, so a refused actor cannot probe which ids exist. */
    it("refuses a non-person with attester_not_user even for a substance that does not exist", async () => {
      expect(await refusal(attest({ type: "agent", id: "a" }, "01HNOSUCHSUBSTANCE00000001", { saltId: "x" })))
        .toBe("attester_not_user");
    });
  });

  // ─────────────────────────────── the decision and its projection ───────────────────────────────

  describe("attesting moves exactly the rows derived from that substance", () => {
    it("records the decision, and re-points every product row, row by row", async () => {
      const { amox, amoxTri, clav, augmentin, mox } = await augmentinWorld();

      const decision = await attest(PHARMACIST, amoxTri.id, { saltId: amox });

      const s = await substance(amoxTri.id);
      expect(s.mappingStatus).toBe("mapped");
      expect(s.saltId).toBe(amox);
      expect(s.mappedBy).toBe(PHARMACIST.id);
      expect(s.mappedAt).not.toBeNull();

      expect(await saltsOf(mox)).toEqual([amox]);
      // PER ROW: Augmentin's amoxicillin moved, its clavulanate did not. Both rows are still there.
      expect(await saltsOf(augmentin)).toEqual([amox, clav.image].sort());
      const amoxRow = (await composition(augmentin)).find((c) => c.saltId === amox);
      expect(amoxRow).toEqual({ saltId: amox, source: "derived", derivedFrom: SCT.amoxTrihydrate });

      expect(decision.projection).toEqual({ rowsMoved: 2, medicinesMoved: 2, medicinesBlocked: 0 });
      const [event] = await payloads("substance.mapped");
      expect(event).toMatchObject({
        substanceId: amoxTri.id, sctid: SCT.amoxTrihydrate, saltId: amox,
        fromStatus: "pending", fromSaltId: null, createdMoiety: false, ownEntry: false,
        proposalId: null, agreedWithProposal: null, correctionReason: null,
        projection: { rowsMoved: 2, medicinesMoved: 2, medicinesBlocked: 0 },
      });
    });

    /**
     * The rank must CHANGE across the decision for this to prove anything: amoxicillin already has
     * a hand-typed product, so after the move it carries 3 and the image carries 0, and a product's
     * rank (the largest count among its moieties) goes from 2 to 3. With equal counts either side, a
     * missing refresh would read as correct.
     */
    it("moves the typeahead's ranking signal with the rows", async () => {
      const { amox, amoxTri, augmentin } = await augmentinWorld();
      await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "Novamox 500", form: "capsule", routeClass: "systemic", salts: [{ saltId: amox }],
      }));
      await withTx(db, (tx) => refreshRankSignals(tx, "all"));
      const rankOf = async (id: string) => Number((await db.execute<{ salt_rank: number }>(
        sql`select salt_rank from formulary_medicines where id = ${id}`)).rows[0]?.salt_rank);
      expect([await productCount(amoxTri.image), await productCount(amox), await rankOf(augmentin)]).toEqual([2, 1, 2]);

      await attest(PHARMACIST, amoxTri.id, { saltId: amox });

      expect([await productCount(amoxTri.image), await productCount(amox), await rankOf(augmentin)]).toEqual([0, 3, 3]);
    });

    it("never touches a medicine a pharmacist composed by hand, even on the same release entry (E3)", async () => {
      const { amox, amoxTri } = await augmentinWorld();
      const { medicineId: handTyped } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "Novamox 500", form: "capsule", routeClass: "systemic",
        salts: [{ saltId: amoxTri.image, strength: "500 mg" }],
      }));

      await attest(PHARMACIST, amoxTri.id, { saltId: amox });

      expect(await composition(handTyped)).toEqual([{ saltId: amoxTri.image, source: "curated", derivedFrom: null }]);
    });

    /**
     * No writer in this repo produces a medicine with both kinds of row today (`updateMedicine`
     * replaces a composition whole). The schema's rule for any derivation is written for the writer
     * that one day does, so the state is built by hand here, and the guard is held to it.
     */
    it("never touches a medicine that carries ANY curated row, even beside a derived one (E3)", async () => {
      const { amox, amoxTri, clav } = await augmentinWorld();
      const mixed = await catalogueProduct("Clavam 625", [{ salt: amoxTri.image, sctid: SCT.amoxTrihydrate }]);
      await db.execute(sql`
        insert into formulary_medicine_salts (medicine_id, salt_id, strength, source)
        values (${mixed}, ${clav.image}, '125 mg', 'curated')
      `);

      const decision = await attest(PHARMACIST, amoxTri.id, { saltId: amox });

      expect(await saltsOf(mixed)).toEqual([amoxTri.image, clav.image].sort());
      expect(decision.projection.medicinesBlocked).toBe(1);
    });

    it("leaves a product naming one moiety twice where it is, and counts it (E2)", async () => {
      const calcium = await moiety("calcium");
      const glub = await releaseSubstance(SCT.calciumGlubionate, "Calcium glubionate (substance)", "Calcium glubionate");
      const lacto = await releaseSubstance(SCT.calciumLactobionate, "Calcium lactobionate (substance)", "Calcium lactobionate");
      const sandoz = await catalogueProduct("Calcium Sandoz Syrup", [
        { salt: glub.image, sctid: SCT.calciumGlubionate, strength: "218 mg/ml" },
        { salt: lacto.image, sctid: SCT.calciumLactobionate, strength: "144.6 mg/ml" },
      ]);

      const first = await attest(PHARMACIST, glub.id, { saltId: calcium });
      expect(first.projection).toEqual({ rowsMoved: 1, medicinesMoved: 1, medicinesBlocked: 0 });

      const second = await attest(PHARMACIST, lacto.id, { saltId: calcium });

      expect(second.projection).toEqual({ rowsMoved: 0, medicinesMoved: 0, medicinesBlocked: 1 });
      expect(await saltsOf(sandoz)).toEqual([calcium, lacto.image].sort());
      // The decision itself still stands: the substance IS calcium. Only the projection declined.
      expect((await substance(lacto.id)).saltId).toBe(calcium);
    });

    /**
     * A decision's event is the audit record of what THAT decision moved. A product of another,
     * earlier-mapped substance that is still out of place (loaded after its decision) is the
     * importer's to place. Sweeping it up here would record it against the wrong pharmacist and
     * turn every attestation into a scan of the whole catalogue.
     */
    it("moves and counts only the decided substance's rows", async () => {
      const { amox, clav } = await augmentinWorld();
      const warfarin = await moiety("warfarin");
      const warfNa = await releaseSubstance(SCT.warfarinSodium, "Warfarin sodium (substance)", "Warfarin sodium");
      await attest(PHARMACIST, warfNa.id, { saltId: warfarin });
      const loadedLater = await catalogueProduct("Warf 5", [{ salt: warfNa.image, sctid: SCT.warfarinSodium }]);

      const decision = await attest(PHARMACIST, clav.id, { newMoiety: { name: "clavulanic acid" } });

      expect(decision.projection).toEqual({ rowsMoved: 1, medicinesMoved: 1, medicinesBlocked: 0 });
      expect(await saltsOf(loadedLater)).toEqual([warfNa.image]);
      expect(amox).toBeDefined();
    });

    it("places a product loaded after the decision when the importer projects the whole catalogue", async () => {
      const amox = await moiety("amoxicillin", "penicillin");
      const amoxTri = await releaseSubstance(SCT.amoxTrihydrate, "Amoxicillin trihydrate (substance)", "Amoxicillin trihydrate");
      await attest(PHARMACIST, amoxTri.id, { saltId: amox });
      const late = await catalogueProduct("Mox 500", [{ salt: amoxTri.image, sctid: SCT.amoxTrihydrate }]);

      const placed = await withTx(db, (tx) => projectSubstances(tx, "all"));

      expect(placed).toEqual({ rowsMoved: 1, medicinesMoved: 1, medicinesBlocked: 0 });
      expect(await saltsOf(late)).toEqual([amox]);
    });
  });

  // ─────────────────────────────── what may be chosen ───────────────────────────────

  describe("the target", () => {
    it("\"it is its own moiety\": choosing the substance's own entry moves nothing and makes it a moiety", async () => {
      const para = await releaseSubstance(SCT.paracetamol, "Paracetamol (substance)", "Paracetamol");
      const crocin = await catalogueProduct("Crocin 500", [{ salt: para.image, sctid: SCT.paracetamol }]);
      expect((await searchMedicines(db, "crocin"))[0]?.reviewed).toBe(false);
      expect((await catalogueCensus(db)).unreviewedActiveMedicines).toBe(1);

      const decision = await attest(PHARMACIST, para.id, { saltId: para.image });

      expect(decision.projection).toEqual({ rowsMoved: 0, medicinesMoved: 0, medicinesBlocked: 0 });
      expect(await saltsOf(crocin)).toEqual([para.image]);
      expect((await payloads("substance.mapped"))[0]).toMatchObject({ ownEntry: true, createdMoiety: false });
      expect((await searchMedicines(db, "crocin"))[0]?.reviewed).toBe(true);
      expect((await catalogueCensus(db)).unreviewedActiveMedicines).toBe(0);
    });

    /**
     * A curated `paracetamol` cannot exist beside the importer's `Paracetamol`: the name is unique
     * case-insensitively. This is WHY "its own entry" is a target at all, and the refusal is the
     * masters' own, rolled back whole.
     */
    it("refuses to create a moiety whose name a release entry already holds, and writes nothing", async () => {
      const para = await releaseSubstance(SCT.paracetamol, "Paracetamol (substance)", "Paracetamol");

      expect(await refusal(attest(PHARMACIST, para.id, { newMoiety: { name: "paracetamol" } }))).toBe("duplicate_name");
      expect((await substance(para.id)).mappingStatus).toBe("pending");
      expect(await payloads("salt.added")).toHaveLength(0);
    });

    it("refuses ANOTHER substance's unreviewed entry, and accepts it once that substance is decided", async () => {
      const diclo = await releaseSubstance(SCT.diclofenac, "Diclofenac (substance)", "Diclofenac");
      const dicloNa = await releaseSubstance(SCT.diclofenacSodium, "Diclofenac sodium (substance)", "Diclofenac sodium");
      const voveran = await catalogueProduct("Voveran 50", [{ salt: dicloNa.image, sctid: SCT.diclofenacSodium }]);

      expect(await refusal(attest(PHARMACIST, dicloNa.id, { saltId: diclo.image }))).toBe("release_image_target");
      expect((await substance(dicloNa.id)).mappingStatus).toBe("pending");

      await attest(PHARMACIST, diclo.id, { saltId: diclo.image });
      await attest(PHARMACIST, dicloNa.id, { saltId: diclo.image });

      expect(await saltsOf(voveran)).toEqual([diclo.image]);
      expect((await searchMedicines(db, "voveran"))[0]?.reviewed).toBe(true);
    });

    it("refuses an inactive moiety (E7) and an id that names nothing", async () => {
      const { amox, amoxTri } = await augmentinWorld();
      await withTx(db, (tx) => updateSalt(tx, PHARMACIST, amox, { active: false }));

      expect(await refusal(attest(PHARMACIST, amoxTri.id, { saltId: amox }))).toBe("unknown_salt");
      expect(await refusal(attest(PHARMACIST, amoxTri.id, { saltId: "01HNOSUCHSALT0000000000001" }))).toBe("unknown_salt");
      expect(await refusal(attest(PHARMACIST, "01HNOSUCHSUBSTANCE00000001", { saltId: amox }))).toBe("unknown_substance");
    });

    it("creates the moiety and maps to it in one act (E12)", async () => {
      const { amoxTri, clav, augmentin } = await augmentinWorld();

      await attest(PHARMACIST, clav.id, { newMoiety: { name: "clavulanic acid", drugClass: "beta-lactamase inhibitor" } });

      const s = await substance(clav.id);
      const created = (await pageSalts(db, { q: "clavulanic acid" })).items[0];
      expect(created?.name).toBe("clavulanic acid");
      expect(created?.drugClass).toBe("beta-lactamase inhibitor");
      expect(s.saltId).toBe(created?.id);
      expect(await saltsOf(augmentin)).toEqual([amoxTri.image, created?.id].sort());
      expect((await payloads("substance.mapped"))[0]).toMatchObject({ createdMoiety: true });
      // The masters' own event, once for this act (the fixture's amoxicillin is the other one).
      expect((await payloads("salt.added")).map((p) => p["name"])).toEqual(["amoxicillin", "clavulanic acid"]);
    });
  });

  // ─────────────────────────────── decided, corrected, contested ───────────────────────────────

  describe("a decision is changed only by a correction (E5, E6)", () => {
    it("refuses a second plain decision, and a correction of an undecided substance", async () => {
      const { amox, amoxTri, clav } = await augmentinWorld();
      await attest(PHARMACIST, amoxTri.id, { saltId: amox });

      expect(await refusal(attest(COLLEAGUE, amoxTri.id, { saltId: amox }))).toBe("substance_already_decided");
      expect(await refusal(attest(PHARMACIST, clav.id, { saltId: amox }, { correctionReason: "because" })))
        .toBe("substance_not_decided");
      expect(await refusal(withTx(db, (tx) => ruleSubstanceUnmappable(tx, COLLEAGUE, amoxTri.id, { reason: "x" }))))
        .toBe("substance_already_decided");
    });

    it("a correction moves the rows from the wrong moiety to the right one, and keeps the wrong one on record", async () => {
      const warfarin = await moiety("warfarin");
      const aspirin = await moiety("aspirin", "nsaid");
      const warfNa = await releaseSubstance(SCT.warfarinSodium, "Warfarin sodium (substance)", "Warfarin sodium");
      const warf = await catalogueProduct("Warf 5", [{ salt: warfNa.image, sctid: SCT.warfarinSodium, strength: "5 mg" }]);
      await attest(PHARMACIST, warfNa.id, { saltId: aspirin }); // the mis-click
      expect(await saltsOf(warf)).toEqual([aspirin]);

      const fixed = await attest(COLLEAGUE, warfNa.id, { saltId: warfarin }, {
        correctionReason: "mis-click: warfarin sodium is warfarin",
      });

      expect(fixed.projection).toEqual({ rowsMoved: 1, medicinesMoved: 1, medicinesBlocked: 0 });
      expect(await saltsOf(warf)).toEqual([warfarin]);
      expect((await substance(warfNa.id)).mappedBy).toBe(COLLEAGUE.id);
      const correction = (await payloads("substance.mapped"))[1];
      expect(correction).toMatchObject({
        saltId: warfarin, fromStatus: "mapped", fromSaltId: aspirin,
        correctionReason: "mis-click: warfarin sodium is warfarin",
      });
    });

    it("refuses a correction that names the moiety already recorded", async () => {
      const { amox, amoxTri } = await augmentinWorld();
      await attest(PHARMACIST, amoxTri.id, { saltId: amox });

      expect(await refusal(attest(PHARMACIST, amoxTri.id, { saltId: amox }, { correctionReason: "again" })))
        .toBe("substance_already_decided");
      expect(await payloads("substance.mapped")).toHaveLength(1);
    });

    it("an unmappable ruling returns the rows to the release entry (E4)", async () => {
      const lacto = await releaseSubstance(SCT.lactobacillus, "Lactobacillus (substance)", "Lactobacillus");
      const sporlac = await catalogueProduct("Sporlac", [{ salt: lacto.image, sctid: SCT.lactobacillus }]);
      // "lactobacillus" itself is taken by the release entry, case-insensitively; the label name is not.
      await attest(PHARMACIST, lacto.id, { newMoiety: { name: "lactic acid bacillus" } });
      expect(await saltsOf(sporlac)).not.toEqual([lacto.image]);

      const ruled = await withTx(db, (tx) => ruleSubstanceUnmappable(tx, COLLEAGUE, lacto.id, {
        reason: "an organism, not a drug moiety: no allergy class or interaction pair can name it", correction: true,
      }));

      expect(ruled.projection).toEqual({ rowsMoved: 1, medicinesMoved: 1, medicinesBlocked: 0 });
      expect(await saltsOf(sporlac)).toEqual([lacto.image]);
      const s = await substance(lacto.id);
      expect([s.mappingStatus, s.saltId, s.mappedBy]).toEqual(["unmappable", null, COLLEAGUE.id]);
      expect((await payloads("substance.ruled_unmappable"))[0]).toMatchObject({
        fromStatus: "mapped", reason: "an organism, not a drug moiety: no allergy class or interaction pair can name it",
      });
      expect((await searchMedicines(db, "sporlac"))[0]?.reviewed).toBe(false);
    });

    it("an unmappable ruling on a pending substance needs no correction flag, and a second one is refused", async () => {
      const lacto = await releaseSubstance(SCT.lactobacillus, "Lactobacillus (substance)", "Lactobacillus");
      await withTx(db, (tx) => ruleSubstanceUnmappable(tx, PHARMACIST, lacto.id, { reason: "an organism" }));

      expect(await refusal(withTx(db, (tx) => ruleSubstanceUnmappable(tx, PHARMACIST, lacto.id, {
        reason: "still an organism", correction: true,
      })))).toBe("substance_already_decided");
    });

    /**
     * Two pharmacists open the same substance and both press. The row lock serialises them; the
     * second reads the first one's decision and is told so. Neither is silently overwritten.
     */
    it("of two simultaneous decisions exactly one lands", async () => {
      const { amox, amoxTri } = await augmentinWorld();
      const warfarin = await moiety("warfarin");

      const outcomes = await Promise.allSettled([
        attest(PHARMACIST, amoxTri.id, { saltId: amox }),
        attest(COLLEAGUE, amoxTri.id, { saltId: warfarin }),
      ]);

      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === "rejected");
      expect((rejected as PromiseRejectedResult | undefined)?.reason).toBeInstanceOf(FormularyError);
      expect(((rejected as PromiseRejectedResult).reason as FormularyError).code).toBe("substance_already_decided");
      expect(await payloads("substance.mapped")).toHaveLength(1);
    });
  });

  // ─────────────────────────────── drafts ───────────────────────────────

  describe("drafts are advice, and agreement is measured against the one on screen", () => {
    it("records agreement case-insensitively, and disagreement as false rather than null", async () => {
      const { amox, amoxTri, clav } = await augmentinWorld();
      await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
        { sctid: SCT.amoxTrihydrate, moietyName: "Amoxicillin", basis: "release_boss", evidence: {} },
        { sctid: SCT.clavulanate, moietyName: "clavulanic acid", basis: "release_boss", evidence: {} },
      ]));
      const page = await pageMappingWorklist(db, { limit: 10 });
      const draftFor = (id: string) => page.items.find((i) => i.id === id)?.proposals[0]?.id ?? null;

      await attest(PHARMACIST, amoxTri.id, { saltId: amox }, { proposalId: draftFor(amoxTri.id) });
      await attest(PHARMACIST, clav.id, { newMoiety: { name: "clavulanate" } }, { proposalId: draftFor(clav.id) });

      const [agreed, disagreed] = await payloads("substance.mapped");
      expect(agreed?.["agreedWithProposal"]).toBe(true);
      expect(disagreed?.["agreedWithProposal"]).toBe(false);
    });

    it("refuses a draft that belongs to a different substance, and writes nothing", async () => {
      const { amox, amoxTri } = await augmentinWorld();
      await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
        { sctid: SCT.clavulanate, moietyName: "clavulanic acid", basis: "release_boss", evidence: {} },
      ]));
      const clavDraft = (await pageMappingWorklist(db, {})).items.flatMap((i) => i.proposals)[0]?.id ?? "";

      expect(await refusal(attest(PHARMACIST, amoxTri.id, { saltId: amox }, { proposalId: clavDraft }))).toBe("unknown_proposal");
      expect((await substance(amoxTri.id)).mappingStatus).toBe("pending");
    });

    it("refuses a whole draft file naming a substance the release does not hold, and names it", async () => {
      await augmentinWorld();

      const result = await withTx(db, (tx) => writeProposals(tx, "agent:model-x", [
        { sctid: SCT.amoxTrihydrate, moietyName: "amoxicillin", basis: "agent", evidence: { model: "model-x", rationale: "trihydrate salt" } },
        { sctid: "999999999", moietyName: "nothing", basis: "agent", evidence: { model: "model-x", rationale: "?" } },
      ]));

      expect(result).toEqual({ written: 0, unknownSctids: ["999999999"] });
      expect((await pageMappingWorklist(db, {})).items.flatMap((i) => i.proposals)).toHaveLength(0);
    });

    it("a re-run replaces a drafter's own draft and leaves another drafter's alone", async () => {
      const { amoxTri } = await augmentinWorld();
      await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
        { sctid: SCT.amoxTrihydrate, moietyName: "amoxicilin", basis: "release_boss", evidence: {} },
      ]));
      await withTx(db, (tx) => writeProposals(tx, "agent:model-x", [
        { sctid: SCT.amoxTrihydrate, moietyName: "amoxicillin", basis: "agent", evidence: { model: "model-x", rationale: "salt form" } },
      ]));
      await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
        { sctid: SCT.amoxTrihydrate, moietyName: "amoxicillin", basis: "release_boss", evidence: {} },
      ]));

      const item = (await pageMappingWorklist(db, {})).items.find((i) => i.id === amoxTri.id);
      expect(item?.proposals.map((p) => [p.draftedBy, p.moietyName, p.basis])).toEqual([
        ["drafter:release@1", "amoxicillin", "release_boss"],
        ["agent:model-x", "amoxicillin", "agent"],
      ]);
    });
  });

  // ─────────────────────────────── the worklist ───────────────────────────────

  describe("the worklist", () => {
    it("lists one decision state, most-used first, and pages without a repeat or a gap", async () => {
      const { amox, amoxTri, clav } = await augmentinWorld();
      const para = await releaseSubstance(SCT.paracetamol, "Paracetamol (substance)", "Paracetamol");
      for (const brand of ["Crocin 500", "Dolo 650", "Calpol 500"]) {
        await catalogueProduct(brand, [{ salt: para.image, sctid: SCT.paracetamol }]);
      }
      const lacto = await releaseSubstance(SCT.lactobacillus, "Lactobacillus (substance)", null);
      await withTx(db, (tx) => refreshRankSignals(tx, "all"));

      const seen: string[] = [];
      let cursor: string | null = null;
      // Bounded: a keyset that never advances must fail this test, not hang the suite.
      for (let pages = 0; pages < 10; pages += 1) {
        const page: Awaited<ReturnType<typeof pageMappingWorklist>> = await pageMappingWorklist(db, { limit: 1, cursor });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }

      // paracetamol 3, amoxicillin trihydrate 2, clavulanate 1, lactobacillus 0 (no entry at all: E11).
      expect(seen).toEqual([para.id, amoxTri.id, clav.id, lacto.id]);

      await attest(PHARMACIST, amoxTri.id, { saltId: amox });
      expect((await pageMappingWorklist(db, {})).items.map((i) => i.id)).toEqual([para.id, clav.id, lacto.id]);
      const mapped = (await pageMappingWorklist(db, { status: "mapped" })).items;
      expect(mapped.map((i) => [i.id, i.saltName, i.mappedBy])).toEqual([[amoxTri.id, "amoxicillin", PHARMACIST.id]]);
    });

    it("says what each draft's name already is, so the screen can offer the right act", async () => {
      const { amoxTri, clav } = await augmentinWorld();
      const para = await releaseSubstance(SCT.paracetamol, "Paracetamol (substance)", "Paracetamol");
      const diclo = await releaseSubstance(SCT.diclofenac, "Diclofenac (substance)", "Diclofenac");
      const dicloNa = await releaseSubstance(SCT.diclofenacSodium, "Diclofenac sodium (substance)", "Diclofenac sodium");
      await withTx(db, (tx) => writeProposals(tx, "drafter:release@1", [
        { sctid: SCT.amoxTrihydrate, moietyName: "AMOXICILLIN", basis: "release_boss", evidence: {} },
        { sctid: SCT.clavulanate, moietyName: "clavulanic acid", basis: "release_boss", evidence: {} },
        { sctid: SCT.paracetamol, moietyName: "paracetamol", basis: "release_base", evidence: {} },
        { sctid: SCT.diclofenacSodium, moietyName: "diclofenac", basis: "release_boss", evidence: {} },
      ]));

      const state = async (id: string) => {
        const p = (await pageMappingWorklist(db, { limit: 50 })).items.find((i) => i.id === id)?.proposals[0];
        return [p?.existingState, p?.existingSaltId];
      };
      expect(await state(amoxTri.id)).toEqual(["moiety", expect.any(String)]);
      expect(await state(clav.id)).toEqual(["none", null]);
      expect(await state(para.id)).toEqual(["own_entry", para.image]);
      expect(await state(dicloNa.id)).toEqual(["other_entry", diclo.image]);

      await attest(PHARMACIST, diclo.id, { saltId: diclo.image });
      expect(await state(dicloNa.id)).toEqual(["moiety", diclo.image]);
    });

    it("shows the clinical drugs a substance appears in, and escapes the pharmacist's wildcard", async () => {
      const { clav } = await augmentinWorld();
      const genericId = newId();
      await db.execute(sql`
        insert into formulary_generics (id, sctid, name, name_normalized, dose_form, route_of_administration, source, created_by, updated_by)
        values (${genericId}, '2826761000189105',
                'Product containing precisely amoxicillin (as amoxicillin trihydrate) 500 milligram and clavulanic acid (as clavulanate potassium) 125 milligram/1 each conventional release oral tablet (clinical drug)',
                'amoxicillin (as amoxicillin trihydrate) 500 milligram and clavulanic acid (as clavulanate potassium) 125 milligram/1 each conventional release oral tablet',
                'Oral tablet', 'Oral route', 'nrces-2026-09', 'nrces-test', 'nrces-test')
      `);
      await db.execute(sql`insert into formulary_generic_substances (generic_id, substance_id) values (${genericId}, ${clav.id})`);

      const item = (await pageMappingWorklist(db, { q: "clavul" })).items;
      expect(item.map((i) => i.id)).toEqual([clav.id]);
      expect(item[0]?.sampleGenerics).toEqual([expect.stringContaining("clavulanic acid (as clavulanate potassium)")]);
      expect((await pageMappingWorklist(db, { q: "%" })).items).toEqual([]);
    });
  });

  describe("the moiety picker", () => {
    it("offers curated moieties and attested entries, never an unreviewed release entry", async () => {
      const { amox } = await augmentinWorld();
      const para = await releaseSubstance(SCT.paracetamol, "Paracetamol (substance)", "Paracetamol");
      const names = async () => (await pageSalts(db, { moietiesOnly: true, limit: 50 })).items.map((s) => s.id);

      expect(await names()).toEqual([amox]);
      await attest(PHARMACIST, para.id, { saltId: para.image });
      expect((await names()).sort()).toEqual([amox, para.image].sort());
      expect((await pageSalts(db, { limit: 50 })).items).toHaveLength(4);
    });
  });
});
