import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { withTx } from "../../kernel/db/client";
import { formularyMedicines } from "../../kernel/db/schema";
import { equivalentMedicines, isEquivalentMedicine } from "./equivalence";
import { addMedicine, addSalt, updateMedicine } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { RouteClass } from "./masters";
import { normalizeDrugName } from "./resolve";

/**
 * ═══ GENERIC EQUIVALENCE — THE RULE THAT USED TO BE WRITTEN TWICE ═══
 *
 * `equivalence.ts` replaced two hand-written JS copies of one sentence: one deciding what the
 * substitution dropdown OFFERS (`alternativesFor`) and one deciding what the dispensing gate
 * ACCEPTS (`verifyDispense`). Nothing asserted the two agreed, and two copies of one rule drift —
 * a counter offered a substitution the gate then refuses, or the reverse, which is the dangerous
 * direction. This suite is the pin on the single predicate they both became.
 *
 * EVERY CLAUSE OF THAT PREDICATE PREVENTS A NAMED DEFECT, and each one gets a case here, because a
 * suite that only proved the happy pair works would stay green while any of them was deleted:
 *
 *   `(select count(*) from want) > 0` .... two composition-less brands substituting for each other
 *   `count(*) = count(want)` ............. an FDC substituted by one of its own ingredients
 *   the double `not exists` .............. a same-sized but different set of moieties
 *   `coalesce(strength_label, '')` ....... two unlabelled products quietly ceasing to be equivalent
 *   `c.form` / `c.route_class` ........... a tablet for an injection, an angina ointment for a fissure
 *   `m.active` / `c.active` .............. a withdrawn product still being offered at the counter
 *   `c.id = any(among)` .................. an answer the size of the national catalogue
 *
 * FIXTURES ARE REAL PHARMACOLOGY (the house rule stated in `masters.test.ts`): Augmentin IS
 * amoxicillin + clavulanic acid, Dolo 650 IS the same moiety as Crocin 500 at another strength,
 * Betadine and Cipladine ARE interchangeable povidone-iodine ointments. A green suite over invented
 * drugs would prove the SQL runs and nothing about whether it is the right SQL.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };

describe("generic equivalence — one predicate for the offer and the gate", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  /** Only the cases that need the pharmacy's own fixture seed one; `unregister` is undone after each. */
  let fx: PharmacyFixture | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });
  afterEach(() => { fx?.unregister(); fx = null; });

  async function pharmacyBase(): Promise<PharmacyFixture> {
    fx = await seedPharmacyBase(db);
    return fx;
  }

  async function mkSalt(name: string, drugClass?: string): Promise<string> {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name, drugClass: drugClass ?? null }));
    return saltId;
  }

  /** `form` defaults to tablet and `routeClass` to systemic so a case states only what it varies. */
  async function mkMed(input: {
    brandName: string; salts: string[];
    form?: string; routeClass?: RouteClass; strengthLabel?: string | null; scheduleFlag?: string | null;
  }): Promise<string> {
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: input.brandName,
      form: input.form ?? "tablet",
      routeClass: input.routeClass ?? "systemic",
      strengthLabel: input.strengthLabel ?? null,
      scheduleFlag: input.scheduleFlag ?? null,
      salts: input.salts.map((saltId) => ({ saltId })),
    }));
    return medicineId;
  }

  /**
   * A BRAND WITH NO COMPOSITION — inserted RAW, on purpose, because `addMedicine` refuses one
   * (`unknown_salt`, "needs at least one moiety", masters.ts M4). The domain refusal is right and
   * this is not a hole in it: the rows exist anyway, because the catalogue importer writes
   * `formulary_medicines` directly and the real national bundle carries composition-less products.
   * So the predicate has to survive rows the curation surface would never have minted.
   */
  async function mkUncomposedMed(brandName: string): Promise<string> {
    const id = newId();
    await db.insert(formularyMedicines).values({
      id, brandName, nameNormalized: normalizeDrugName(brandName), form: "tablet", routeClass: "systemic",
      createdBy: "catalogue-import", updatedBy: "catalogue-import",
    });
    return id;
  }

  const idsOf = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

  /** Paracetamol 500 mg tablets: Crocin and Calpol really are the same product under two brands. */
  async function paracetamolPair(): Promise<{ para: string; crocin: string; calpol: string }> {
    const para = await mkSalt("Paracetamol", "analgesic");
    const crocin = await mkMed({ brandName: "Crocin 500", salts: [para], strengthLabel: "500 mg", scheduleFlag: "OTC" });
    const calpol = await mkMed({ brandName: "Calpol 500", salts: [para], strengthLabel: "500 mg", scheduleFlag: "OTC" });
    return { para, crocin, calpol };
  }

  // ───────────────────────────── the pair the whole thing exists for ─────────────────────────────

  /**
   * THE POSITIVE CASE, IN BOTH DIRECTIONS. Equivalence is symmetric by construction — the predicate
   * compares two sets — but the SQL is not symmetric in SHAPE: the source is read through a CTE
   * with its own `active` test and the candidate through the outer `where`. A one-sided assertion
   * would leave half of that untested, and "Calpol may replace Crocin but not the other way round"
   * is a counter-visible absurdity.
   *
   * The row is asserted WHOLE rather than by id, because the fields are the substitution screen's
   * entire payload: `strengthLabel` is what a pharmacist reads back to the patient, and
   * `scheduleFlag` is the law the caller applies for itself (see the schedule case below).
   */
  it("a true generic pair is equivalent in both directions, and the row carries what the counter shows", async () => {
    const { med } = await pharmacyBase();
    const shelf = [med.crocin, med.calpol, med.azithro, med.alprax, med.ibuprofen];

    expect(await equivalentMedicines(db, med.crocin, { among: shelf })).toEqual([
      { id: med.calpol, brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", routeClass: "systemic", scheduleFlag: "OTC" },
    ]);
    expect(await equivalentMedicines(db, med.calpol, { among: shelf })).toEqual([
      { id: med.crocin, brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", routeClass: "systemic", scheduleFlag: "OTC" },
    ]);
    // Ibuprofen is an analgesic too, and an analgesic is not a substitute for another analgesic.
    expect(await equivalentMedicines(db, med.ibuprofen, { among: shelf })).toEqual([]);
  });

  // ─────────────────────────────── the composition clauses ───────────────────────────────

  /**
   * THE SUBSET, KILLED BY `count(*) = count(want)`.
   *
   * Augmentin 625 IS amoxicillin + clavulanic acid. Handing the patient plain amoxicillin instead
   * is a real dispensing error with a real consequence — the clavulanic acid is the beta-lactamase
   * inhibitor, and without it the resistant organism the combination was chosen for is untreated.
   *
   * Everything except composition is held equal (same form, same route, both unlabelled — the
   * catalogue's branded rows routinely carry no strength label), so the COUNT is the only clause
   * that can exclude the candidate. Vary anything else and this case would go green over a deleted
   * count clause, which is exactly the false green it exists to prevent.
   */
  it("an FDC is not equivalent to one of its own ingredients — the strict subset", async () => {
    const amox = await mkSalt("Amoxicillin", "penicillin");
    const clav = await mkSalt("Clavulanic acid");
    const augmentin = await mkMed({ brandName: "Augmentin 625", salts: [amox, clav] });
    const novamox = await mkMed({ brandName: "Novamox 500 DT", salts: [amox] });

    expect(await equivalentMedicines(db, augmentin, { among: [novamox] })).toEqual([]);
    expect(await isEquivalentMedicine(db, augmentin, novamox)).toBe(false);
  });

  /**
   * THE SUPERSET — the same two products, asked the other way round.
   *
   * A SEPARATE CASE because it is a separate clinical error: giving a patient prescribed plain
   * amoxicillin a co-amoxiclav tablet adds a moiety nobody prescribed (and clavulanate is the half
   * that causes the diarrhoea). It is also the direction a naive "does the candidate contain
   * everything the source has?" implementation gets WRONG while passing the subset case.
   */
  it("a plain drug is not equivalent to the FDC that contains it — the strict superset", async () => {
    const amox = await mkSalt("Amoxicillin", "penicillin");
    const clav = await mkSalt("Clavulanic acid");
    const augmentin = await mkMed({ brandName: "Augmentin 625", salts: [amox, clav] });
    const novamox = await mkMed({ brandName: "Novamox 500 DT", salts: [amox] });

    expect(await equivalentMedicines(db, novamox, { among: [augmentin] })).toEqual([]);
    expect(await isEquivalentMedicine(db, novamox, augmentin)).toBe(false);
  });

  /**
   * THE ANTI-JOIN'S OWN CASE: SAME SIZE, DIFFERENT SET.
   *
   * Both products are two-moiety penicillin FDCs of the same form and route, so `count(*) =
   * count(want)` is SATISFIED (2 = 2) and the double `not exists` is the only clause left standing.
   * Without this case the anti-join could be deleted and the suite would stay green: the subset is
   * caught by the count, and the superset is caught by BOTH, so neither of them can see it go.
   *
   * Ampilox is ampicillin + cloxacillin — a different pair of penicillins for a different indication.
   */
  it("two FDCs of the same size but a different set of moieties are not equivalent", async () => {
    const amox = await mkSalt("Amoxicillin", "penicillin");
    const clav = await mkSalt("Clavulanic acid");
    const amp = await mkSalt("Ampicillin", "penicillin");
    const clox = await mkSalt("Cloxacillin", "penicillin");
    const augmentin = await mkMed({ brandName: "Augmentin 625", salts: [amox, clav] });
    const ampilox = await mkMed({ brandName: "Ampilox Kid DT", salts: [amp, clox] });

    expect(await equivalentMedicines(db, augmentin, { among: [ampilox] })).toEqual([]);
    expect(await equivalentMedicines(db, ampilox, { among: [augmentin] })).toEqual([]);
  });

  /**
   * ═══ THE MOST IMPORTANT CASE IN THIS FILE: TWO BRANDS THAT KNOW NOTHING ═══
   *
   * `(select count(*) from want) > 0` is the SQL form of the JS copies' `if (wanted === "") return
   * []`. Delete it and the arithmetic goes quietly, catastrophically true: `0 = 0` satisfies the
   * count equality, and the anti-join over an empty candidate set is VACUOUSLY true — so every
   * composition-less brand becomes substitutable for every other composition-less brand of the same
   * form, label and route. Not a hypothetical: the catalogue importer emits such rows (8 on the real
   * national bundle), and these two are the shape it emits — proprietary herbal formulations with no
   * moiety the formulary knows, which have nothing whatever to do with each other.
   *
   * The failure would be SILENT at every layer above: the dropdown would offer the swap and the gate
   * would accept it, because both of them are this one predicate.
   */
  it("two composition-less brands are NOT substitutable for each other", async () => {
    const liv52 = await mkUncomposedMed("Liv.52 tablet");
    const cystone = await mkUncomposedMed("Cystone tablet");

    expect(await equivalentMedicines(db, liv52, { among: [cystone] })).toEqual([]);
    expect(await equivalentMedicines(db, cystone, { among: [liv52] })).toEqual([]);
    expect(await isEquivalentMedicine(db, liv52, cystone)).toBe(false);

    // And a composed medicine is not equivalent to a composition-less one either, in either
    // direction — the same clause, from the side where `want` is non-empty and the candidate's is.
    const para = await mkSalt("Paracetamol", "analgesic");
    const crocin = await mkMed({ brandName: "Crocin 500", salts: [para] });
    expect(await equivalentMedicines(db, crocin, { among: [liv52] })).toEqual([]);
    expect(await equivalentMedicines(db, liv52, { among: [crocin] })).toEqual([]);
  });

  // ─────────────────────────── strength, form and route ───────────────────────────

  /**
   * SAME MOIETY, DIFFERENT STRENGTH. Crocin 500 and Dolo 650 are both plain paracetamol tablets and
   * are NOT interchangeable: 650 mg handed to someone prescribed 500 is a 30% dose increase decided
   * by a counter. This is the commonest substitution offer an Indian pharmacy could wrongly make,
   * because the brands sit beside each other on the shelf.
   */
  it("the same moiety at a different strength label is not equivalent", async () => {
    const para = await mkSalt("Paracetamol", "analgesic");
    const crocin = await mkMed({ brandName: "Crocin 500", salts: [para], strengthLabel: "500 mg" });
    const dolo = await mkMed({ brandName: "Dolo 650", salts: [para], strengthLabel: "650 mg" });

    expect(await equivalentMedicines(db, crocin, { among: [dolo] })).toEqual([]);
    expect(await isEquivalentMedicine(db, crocin, dolo)).toBe(false);
  });

  /**
   * SAME MOIETY AND STRENGTH, DIFFERENT FORM. Azithromycin 500 exists as a tablet and as an IV
   * vial. Nothing about "same drug, same strength" makes one a substitute for the other: the
   * infusion is for a patient who cannot take it orally, and a counter handing over tablets against
   * an IV line — or the reverse — is not a substitution at all.
   */
  it("the same moiety and strength in a different form is not equivalent", async () => {
    const azi = await mkSalt("Azithromycin", "macrolide");
    const tablet = await mkMed({ brandName: "Azicip 500", salts: [azi], form: "tablet", strengthLabel: "500 mg", scheduleFlag: "H1" });
    const injection = await mkMed({ brandName: "Azithral 500 IV", salts: [azi], form: "injection", strengthLabel: "500 mg", scheduleFlag: "H1" });

    expect(await equivalentMedicines(db, tablet, { among: [injection] })).toEqual([]);
    expect(await equivalentMedicines(db, injection, { among: [tablet] })).toEqual([]);
  });

  /**
   * SAME MOIETY, SAME FORM, DIFFERENT ROUTE CLASS — DD7's two buckets, and the case that shows why
   * the bucket is on the row rather than inferred from the form.
   *
   * Glyceryl trinitrate is sold as an ointment twice over: the low-strength one is applied to the
   * anal margin for a chronic fissure, where it acts LOCALLY on the internal sphincter, and the
   * other is rubbed on the chest for angina, where the whole point is that it is absorbed and acts
   * on the heart. Same moiety, same dose form, opposite intent — and dispensing one for the other
   * is either an untreated fissure or an unintended systemic nitrate.
   *
   * Neither row carries a strength label, which is deliberate: the market distinguishes them by
   * strength, and holding everything but the ROUTE CLASS equal is what makes this case able to see
   * that clause deleted. With a label difference it would pass for the wrong reason.
   */
  it("the same moiety and form in the other route class is not equivalent", async () => {
    const gtn = await mkSalt("Glyceryl trinitrate", "nitrate");
    const fissure = await mkMed({ brandName: "Nitrogesic ointment", salts: [gtn], form: "ointment", routeClass: "topical" });
    const angina = await mkMed({ brandName: "Nitro-Bid ointment", salts: [gtn], form: "ointment", routeClass: "systemic" });

    expect(await equivalentMedicines(db, fissure, { among: [angina] })).toEqual([]);
    expect(await equivalentMedicines(db, angina, { among: [fissure] })).toEqual([]);
  });

  /**
   * TWO UNLABELLED PRODUCTS ARE STILL EQUIVALENT — the `coalesce(strength_label, '')` clause, which
   * exists on BOTH sides of the comparison for the reason SQL beginners meet once and never forget:
   * `null = null` is NULL, not true, so a plain `=` would silently stop two unlabelled products from
   * ever being equivalent. The JS copies wrote it `(a.strengthLabel ?? "") === (b.strengthLabel ?? "")`.
   *
   * This is not an edge case in this catalogue — most branded rows arrive with no strength label at
   * all. Betadine and Cipladine are both 5% povidone-iodine ointment: the same antiseptic, one of
   * the most-substituted items at any Indian counter.
   */
  it("two medicines with NULL strength labels and the same composition ARE equivalent", async () => {
    const pvpi = await mkSalt("Povidone-iodine", "antiseptic");
    const betadine = await mkMed({ brandName: "Betadine ointment", salts: [pvpi], form: "ointment", routeClass: "topical" });
    const cipladine = await mkMed({ brandName: "Cipladine ointment", salts: [pvpi], form: "ointment", routeClass: "topical" });

    const rows = await equivalentMedicines(db, betadine, { among: [cipladine] });
    expect(idsOf(rows)).toEqual([cipladine]);
    expect(rows[0]!.strengthLabel).toBeNull();
    expect(await isEquivalentMedicine(db, cipladine, betadine)).toBe(true);
  });

  // ─────────────────────────────── active, and the bound ───────────────────────────────

  /**
   * A WITHDRAWN PRODUCT IS NOT OFFERED (`and c.active`). Deactivation is how this hospital retires a
   * brand — a recall, a delisting, a formulary decision — and the one thing it has to mean is that
   * nobody is invited to hand it over. The composition is untouched, so only the `active` test can
   * exclude it.
   */
  it("an inactive candidate is never offered as an equivalent", async () => {
    const { crocin, calpol } = await paracetamolPair();
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, calpol, { active: false }));

    expect(await equivalentMedicines(db, crocin, { among: [calpol] })).toEqual([]);
    expect(await isEquivalentMedicine(db, crocin, calpol)).toBe(false);
  });

  /**
   * AN INACTIVE SOURCE HAS NO EQUIVALENTS AT ALL (`and m.active` inside the `src` CTE) — the SQL
   * form of the old lookup through an active-only list returning `undefined`.
   *
   * Note what this does NOT do: it does not stop the medicine being NAMED. `medicinesByIds` in
   * `reads.ts` deliberately ignores `active`, so a label and a refusal can still print the brand.
   * "May it be swapped for something else" is a different question from "what is it called", and
   * only this one is answered here.
   */
  it("an inactive source yields no equivalents, even when a live twin is on the shelf", async () => {
    const { crocin, calpol } = await paracetamolPair();
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, crocin, { active: false }));

    expect(await equivalentMedicines(db, crocin, { among: [calpol] })).toEqual([]);
    expect(await isEquivalentMedicine(db, crocin, calpol)).toBe(false);
  });

  /**
   * `among` IS A MANDATORY UNIVERSE, NOT AN OPTIONAL FILTER — measured, 9,930 equivalence classes
   * over the national catalogue with a max class of 1,581. An unbounded answer is a list nobody can
   * render and an offer no counter can keep, so the pharmacy passes its own SHELF and the cost
   * becomes a property of this hospital rather than of the nation.
   *
   * The assertion that matters is the middle one: Calpol IS equivalent to Crocin and is STILL not
   * returned when the caller did not ask about it. Without the id clause the answer would silently
   * widen to the catalogue — which is the defect this whole lane exists to remove, returning by
   * another name.
   */
  it("`among` is the bound: an equivalent outside it is not returned, and an empty universe answers nothing", async () => {
    const { med } = await pharmacyBase();

    expect(idsOf(await equivalentMedicines(db, med.crocin, { among: [med.calpol] }))).toEqual([med.calpol]);
    expect(await equivalentMedicines(db, med.crocin, { among: [med.azithro, med.alprax, med.ibuprofen] })).toEqual([]);
    expect(await equivalentMedicines(db, med.crocin, { among: [] })).toEqual([]);
  });

  /**
   * A MEDICINE IS NOT ITS OWN SUBSTITUTE. The shelf the pharmacy passes as `among` always contains
   * the prescribed medicine itself, so this is the everyday call, not an edge case: an offer list
   * whose first entry is "Crocin 500 — or substitute with Crocin 500" is a screen that has stopped
   * making sense, and `isEquivalentMedicine(x, x)` returning true would let a "substitution" be
   * recorded against a line nobody substituted.
   *
   * Guarded TWICE on purpose — the JS `filter((id) => id !== medicineId)` and the SQL `c.id <>
   * src.id` — which is why this case asserts the behaviour rather than one of the two guards.
   */
  it("the source is never returned as its own equivalent", async () => {
    const { crocin, calpol } = await paracetamolPair();

    expect(idsOf(await equivalentMedicines(db, crocin, { among: [crocin, calpol] }))).toEqual([calpol]);
    expect(await equivalentMedicines(db, crocin, { among: [crocin] })).toEqual([]);
    expect(await isEquivalentMedicine(db, crocin, crocin)).toBe(false);
  });

  // ──────────────────── the two callers, and what the predicate deliberately omits ────────────────────

  /**
   * ═══ THE PROPERTY THIS FILE EXISTS FOR: THE OFFER AND THE GATE NEVER DISAGREE ═══
   *
   * `isEquivalentMedicine` is not a second implementation — it asks `equivalentMedicines` with a
   * universe of one. This case asserts the two against EACH OTHER rather than against expected
   * values, over an equivalent pair, a different-strength pair and a subset pair, because the thing
   * that must hold is not "both say yes here" but "both say the same thing, always". That is the
   * invariant the two hand-written JS copies could not have, and the one a future edit is most
   * likely to break by "optimising" the boolean into its own query.
   */
  it("isEquivalentMedicine agrees with equivalentMedicines on every pair, yes and no alike", async () => {
    const para = await mkSalt("Paracetamol", "analgesic");
    const ibu = await mkSalt("Ibuprofen", "nsaid");
    const crocin = await mkMed({ brandName: "Crocin 500", salts: [para], strengthLabel: "500 mg" });
    const calpol = await mkMed({ brandName: "Calpol 500", salts: [para], strengthLabel: "500 mg" });
    const dolo = await mkMed({ brandName: "Dolo 650", salts: [para], strengthLabel: "650 mg" });
    // Combiflam IS ibuprofen 400 + paracetamol 325 — a superset of Crocin's single moiety, carrying
    // its own label, so it is a no for two independent reasons at once. Agreement must hold there too.
    const combiflam = await mkMed({ brandName: "Combiflam", salts: [para, ibu], strengthLabel: "400 mg + 325 mg" });

    const pairs: [string, string][] = [
      [crocin, calpol], [calpol, crocin], [crocin, dolo], [dolo, crocin],
      [crocin, combiflam], [combiflam, crocin], [crocin, crocin],
    ];
    for (const [from, to] of pairs) {
      const offered = (await equivalentMedicines(db, from, { among: [to] })).length === 1;
      expect([from, to, await isEquivalentMedicine(db, from, to)]).toEqual([from, to, offered]);
    }
    // …and the agreement is not vacuous: exactly one of those pairs is a yes, in both directions.
    expect(await isEquivalentMedicine(db, crocin, calpol)).toBe(true);
    expect(await isEquivalentMedicine(db, crocin, dolo)).toBe(false);
  });

  /**
   * SCHEDULE IS DELIBERATELY NOT IN THE PREDICATE. A refused schedule is a law about DISPENSING,
   * not a fact about COMPOSITION: Alprax 0.5 and Restyl 0.5 are both alprazolam 0.5 mg tablets and
   * they ARE equivalent — what a counter may not do is hand either of them over, which is a
   * separate refusal with a separate, precise code (`schedule_x_not_dispensed_here`).
   *
   * Folding the schedule in here would turn that precise refusal into a vague
   * `substitution_not_allowed` and hide the reason from the pharmacist. So the row is returned WITH
   * its `scheduleFlag`, and the caller applies its own `REFUSED_FLAGS` — which is what this asserts.
   */
  it("a Schedule X twin is still an equivalent, and arrives carrying the flag the caller must act on", async () => {
    const alp = await mkSalt("Alprazolam", "benzodiazepine");
    const alprax = await mkMed({ brandName: "Alprax 0.5", salts: [alp], strengthLabel: "0.5 mg", scheduleFlag: "X" });
    const restyl = await mkMed({ brandName: "Restyl 0.5", salts: [alp], strengthLabel: "0.5 mg", scheduleFlag: "X" });

    const rows = await equivalentMedicines(db, alprax, { among: [restyl] });
    expect(idsOf(rows)).toEqual([restyl]);
    expect(rows[0]!.scheduleFlag).toBe("X");
    expect(await isEquivalentMedicine(db, alprax, restyl)).toBe(true);
  });

  /**
   * ORDERING IS `brand_name asc` — the offer list is read aloud and scanned by eye, so it is
   * alphabetical, and it must not depend on the order the catalogue happened to be imported in.
   * The three candidates are inserted in reverse alphabetical order for exactly that reason: with
   * an unordered query Postgres would most likely return them in insertion order, so this case can
   * see the clause deleted as well as reversed.
   *
   * (The `id asc` tie-break is unreachable by fixture: `formulary_medicines_brand_lower_ux` makes
   * two rows with the same brand name unstorable, so no test can produce a tie.)
   */
  it("equivalents come back sorted by brand name, not by the order they were catalogued", async () => {
    const para = await mkSalt("Paracetamol", "analgesic");
    const metacin = await mkMed({ brandName: "Metacin 500", salts: [para], strengthLabel: "500 mg" });
    const pacimol = await mkMed({ brandName: "Pacimol 500", salts: [para], strengthLabel: "500 mg" });
    const dolo = await mkMed({ brandName: "Dolo 500", salts: [para], strengthLabel: "500 mg" });
    const calpol = await mkMed({ brandName: "Calpol 500", salts: [para], strengthLabel: "500 mg" });

    const rows = await equivalentMedicines(db, metacin, { among: [pacimol, dolo, calpol] });
    expect(rows.map((r) => r.brandName)).toEqual(["Calpol 500", "Dolo 500", "Pacimol 500"]);
    expect(idsOf(rows)).toEqual([calpol, dolo, pacimol]);
  });
});
