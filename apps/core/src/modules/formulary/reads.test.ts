import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { FormularyError, formularyHttpStatus } from "./errors";
import { addMedicine, addSalt, updateMedicine, updateSalt } from "./masters";
import { MAX_IDS, medicineExists, medicinesByIds, saltsByIds, suggestMoieties } from "./reads";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE ID-KEYED READS (`reads.ts`) — ASK FOR WHAT YOU NEED, AND SAY SO OUT LOUD ═══
 *
 * `catalogue-scale.test.ts` pins the wire-level defect these helpers were written to end: a read
 * whose bind-parameter count scales with the catalogue stops working — with a protocol error, not
 * a slow query — the first day the national drug bundle is loaded. THIS suite pins the OTHER half,
 * which no amount of scale can show: the SEMANTICS the pharmacy counter now depends on. Three
 * promises, each of which a later author can break without breaking a single scale test.
 *
 *   1. AN UNKNOWN ID IS SIMPLY ABSENT. Not an error, not a null-valued key. Callers ask for the
 *      medicines on a dispense and render what came back.
 *   2. `active` IS NOT FILTERED. A brand deactivated after the prescription was written must still
 *      be NAMEABLE — see the case below, which is the reason this file exists at all.
 *   3. PAST `MAX_IDS` THEY REFUSE, THEY DO NOT TRUNCATE. A short map is a wrong answer delivered
 *      quietly; the refusal is a fixable 400 the counter can see.
 *
 * Every fixture here is a real Indian product with its real composition — Crocin 500 and Dolo 650
 * are paracetamol, Augmentin 625 IS amoxicillin 500 + clavulanic acid 125, Glycomet 500 is
 * metformin. The house rule from `masters.test.ts`: a suite green over invented pharmacology
 * proves the plumbing and nothing else, and these helpers exist to carry pharmacology to a label.
 */
const CURATOR: Actor = { type: "user", id: "01HFORMULARYCURATOR00000001" };

/**
 * A DATABASE HANDLE THAT CANNOT BE USED AT ALL.
 *
 * Two of the promises below are about a query that must NOT happen: `medicinesByIds(db, [])` and
 * `medicineExists(db, "")` both know their answer without asking Postgres, and a round trip to
 * learn something you already know is a cost every dispense screen pays. That is unobservable
 * through a real handle — an empty map looks identical whether or not a statement was issued — so
 * the handle itself becomes the instrument. Any property access at all throws, which is stricter
 * than the `phi-access.test.ts` stand-in (an object with exploding `select`/`insert`): here even
 * reaching for a method the helper does not call is a failure, so the assertion is "the database
 * was never touched" rather than "these two methods were not called".
 */
const NEVER_QUERIED = new Proxy({}, {
  get(_target, prop): never {
    throw new Error(`the database was asked for .${String(prop)} — this call must answer without a query`);
  },
}) as unknown as Db;

/** Distinct ids no row carries, for padding a request out to a length the guard has to judge. */
function padding(n: number, tag: string): string[] {
  return Array.from({ length: n }, (_, i) => `01HNOSUCH${tag}${String(i).padStart(12, "0")}`);
}

type Fixture = {
  salt: { paracetamol: string; amoxicillin: string; clavulanic: string; metformin: string };
  med: { crocin: string; dolo: string; augmentin: string; glycomet: string };
};

describe("formulary reads: medicinesByIds / saltsByIds / medicineExists", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: Fixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedFormulary();
  });

  /**
   * Four brands over four moieties. Glycomet 500 and the metformin moiety are then DEACTIVATED
   * through `updateMedicine`/`updateSalt` rather than by writing `active` directly, because the
   * curation path is the only way a row becomes inactive in production and a fixture that skips it
   * is a fixture that can be right about a state the system cannot reach.
   */
  async function seedFormulary(): Promise<Fixture> {
    return withTx(db, async (tx) => {
      const paracetamol = (await addSalt(tx, CURATOR, {
        name: "paracetamol", aliases: ["acetaminophen"], drugClass: "analgesic-antipyretic",
      })).saltId;
      const amoxicillin = (await addSalt(tx, CURATOR, {
        name: "amoxicillin", aliases: ["amoxycillin"], drugClass: "penicillin",
      })).saltId;
      const clavulanic = (await addSalt(tx, CURATOR, {
        name: "clavulanic acid", drugClass: "beta-lactamase inhibitor",
      })).saltId;
      const metformin = (await addSalt(tx, CURATOR, { name: "metformin", drugClass: "biguanide" })).saltId;

      const crocin = (await addMedicine(tx, CURATOR, {
        brandName: "Crocin 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg",
        scheduleFlag: "OTC", salts: [{ saltId: paracetamol, strength: "500 mg" }],
      })).medicineId;
      const dolo = (await addMedicine(tx, CURATOR, {
        brandName: "Dolo 650", form: "tablet", routeClass: "systemic", strengthLabel: "650 mg",
        scheduleFlag: "OTC", salts: [{ saltId: paracetamol, strength: "650 mg" }],
      })).medicineId;
      const augmentin = (await addMedicine(tx, CURATOR, {
        brandName: "Augmentin 625", form: "tablet", routeClass: "systemic", strengthLabel: "625 mg",
        scheduleFlag: "H", salts: [{ saltId: amoxicillin, strength: "500 mg" }, { saltId: clavulanic, strength: "125 mg" }],
      })).medicineId;
      const glycomet = (await addMedicine(tx, CURATOR, {
        brandName: "Glycomet 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg",
        scheduleFlag: "H", salts: [{ saltId: metformin, strength: "500 mg" }],
      })).medicineId;

      await updateMedicine(tx, CURATOR, glycomet, { active: false });
      await updateSalt(tx, CURATOR, metformin, { active: false });
      return {
        salt: { paracetamol, amoxicillin, clavulanic, metformin },
        med: { crocin, dolo, augmentin, glycomet },
      };
    });
  }

  // ───────────────────────────── medicinesByIds: the shape ─────────────────────────────

  it("returns the named medicines keyed by id, each carrying its composition", async () => {
    const out = await medicinesByIds(db, [fx.med.crocin, fx.med.augmentin]);
    expect(out.size).toBe(2);

    // The FDC is the case that matters: two moieties, each with its own per-salt strength, which is
    // the only thing that tells a label "amoxicillin 500 + clavulanic acid 125" rather than "625".
    const augmentin = out.get(fx.med.augmentin)!;
    expect(augmentin.brandName).toBe("Augmentin 625");
    expect(augmentin.salts.map((s) => s.saltId).sort()).toEqual([fx.salt.amoxicillin, fx.salt.clavulanic].sort());
    expect(augmentin.salts.find((s) => s.saltId === fx.salt.amoxicillin)!.strength).toBe("500 mg");
    expect(augmentin.salts.find((s) => s.saltId === fx.salt.clavulanic)!.strength).toBe("125 mg");

    const crocin = out.get(fx.med.crocin)!;
    expect(crocin.brandName).toBe("Crocin 500");
    expect(crocin.salts).toEqual([{ saltId: fx.salt.paracetamol, strength: "500 mg" }]);
  });

  /**
   * The absent-is-absent rule, and the bound it implies. `queue.ts` used to read the catalogue and
   * `.filter()` it down; a caller that got back more than it asked for could keep working by
   * filtering again, and the defect would survive the fix wearing its own clothes. So the count is
   * asserted, not just the membership: four brands are seeded, two are asked for, two come back.
   *
   * An unknown id is NOT an error here on purpose. A dispense line can name a medicine a curator
   * has since merged away, and the caller's job is to render what exists — `unresolved_medicine`
   * is decided by the caller against this map, not by the reader against the database.
   */
  it("asks only for the ids it was given, and an id the catalogue lacks is simply absent", async () => {
    const ghost = "01HGONEMEDICINE000000000001";
    const out = await medicinesByIds(db, [fx.med.crocin, ghost]);
    expect([...out.keys()]).toEqual([fx.med.crocin]);
    expect(out.has(ghost)).toBe(false);
    expect(out.get(ghost)).toBeUndefined();
  });

  /**
   * ═══ THE ONE CASE THIS FILE EXISTS FOR: AN INACTIVE MEDICINE COMES BACK ═══
   *
   * `active` means "may this be OFFERED" — may a doctor pick it, may the counter substitute into
   * it. It does NOT mean "did this ever exist". Those are different questions and this reader
   * answers only the second one.
   *
   * The prescription was written on Tuesday; the curator deactivated the brand on Wednesday; the
   * patient arrives at the counter on Thursday holding a slip that names it. If this read filtered
   * `active`, TWO things break at once and both are silent:
   *
   *   - THE LABEL the patient carries away loses its brand. `label.ts` looks the medicine up in
   *     this map; a miss prints a blank where the name of the drug in the packet should be, on the
   *     only piece of paper that follows the medicine home.
   *   - THE REFUSAL stops naming anything. `verify.ts` explains that a substitution is not allowed
   *     BY NAMING both brands. With the row missing, a precise `substitution_not_allowed` decays
   *     into a vague `unresolved_medicine`, and a pharmacist reads "this drug does not exist"
   *     about a drug that is physically on the counter in front of them.
   *
   * A future author WILL be tempted to add `eq(formulary_medicines.active, true)` here — it looks
   * like tidiness, it matches `listMedicines({ activeOnly })`, and every other read in the module
   * seems to do it. THIS CASE IS WHAT STOPS THEM. Where `active` really is the question, it is
   * asked in SQL at the place that decides, which is `equivalence.ts`.
   */
  it("returns a DEACTIVATED medicine, with its composition, because a withdrawn brand must stay nameable", async () => {
    const out = await medicinesByIds(db, [fx.med.glycomet]);
    const glycomet = out.get(fx.med.glycomet);
    expect(glycomet).toBeDefined();
    expect(glycomet!.active).toBe(false);
    expect(glycomet!.brandName).toBe("Glycomet 500");
    // The composition survives too: a deactivated brand with an empty `salts` array would pass a
    // presence-only assertion and still break every check that reasons about moieties.
    expect(glycomet!.salts).toEqual([{ saltId: fx.salt.metformin, strength: "500 mg" }]);
  });

  // ─────────────────────── medicinesByIds: the bound, from both sides ───────────────────────

  /**
   * PAST THE LIMIT IT REFUSES, AND THE REFUSAL IS THE POINT — it must not return a short map.
   *
   * The outcome is captured as a value rather than asserted with `.rejects` alone so that the
   * TRUNCATING implementation is caught explicitly: `return wanted.slice(0, MAX_IDS)` resolves
   * with a perfectly plausible map, and a `.rejects` matcher would report "received a resolved
   * promise" while a `.size` assertion would report nothing at all. Here the two outcomes are
   * distinguishable in the failure message.
   *
   * `MAX_IDS + 1` distinct ids, because a guard tested at 10,000 is a guard tested nowhere near
   * where it lives — only the id after the last legal one says the boundary is the boundary.
   */
  it(`refuses ${String(MAX_IDS + 1)} ids with too_many_ids rather than returning a short map`, async () => {
    const ids = [fx.med.crocin, ...padding(MAX_IDS, "MED")];
    expect(new Set(ids).size).toBe(MAX_IDS + 1);

    const outcome = await medicinesByIds(db, ids).then(
      (map) => ({ resolved: map.size }),
      (e: unknown) => ({ refused: e }),
    );
    expect(outcome).toEqual({ refused: expect.any(FormularyError) });
    const refusal = (outcome as { refused: FormularyError }).refused;
    expect(refusal.code).toBe("too_many_ids");
    // The detail is what a caller logs to find its own bug: how many it asked for, and the ceiling.
    expect(refusal.detail).toEqual({ asked: MAX_IDS + 1, limit: MAX_IDS });
  });

  /**
   * AND EXACTLY `MAX_IDS` IS ACCEPTED. A guard that fires one early is still a guard in the wrong
   * place: it turns a legal request into a refusal a caller cannot fix, and — because the
   * off-by-one is in the SAFE direction — nothing else in the system ever complains. Only the
   * `>=`/`>` pair of cases can tell the two apart.
   *
   * Deliberately seeded with the three ACTIVE brands, not all four: this case is about the bound,
   * and the inactive-medicine promise above must be able to fail on its own.
   */
  it(`accepts exactly ${String(MAX_IDS)} ids, because a guard one short is a guard in the wrong place`, async () => {
    const ids = [fx.med.crocin, fx.med.dolo, fx.med.augmentin, ...padding(MAX_IDS - 3, "MED")];
    expect(new Set(ids).size).toBe(MAX_IDS);

    const out = await medicinesByIds(db, ids);
    expect(out.size).toBe(3);
    expect([...out.keys()].sort()).toEqual([fx.med.crocin, fx.med.dolo, fx.med.augmentin].sort());
  });

  /**
   * WHAT `requireBounded` ACTUALLY PROMISES: the limit is on DISTINCT, NON-EMPTY ids, not on the
   * length of the array the caller happened to build.
   *
   * This is not a nicety. A caller assembles its list from dispense LINES, and a prescription that
   * names the same brand at two different frequencies — Dolo 650 SOS on top of Dolo 650 TDS, which
   * is an ordinary thing for a doctor to write — hands this reader the same id twice. If raw
   * length were the bound, a legitimate request would be refused for a reason that has nothing to
   * do with anything the caller did. 600 entries, 3 medicines, accepted.
   *
   * The empty-string half of the same promise is pinned by the next case, where its consequence is
   * visible: `""` is not merely uncounted, it is not asked about.
   */
  it("counts DISTINCT non-empty ids toward the limit, so a repeated line is not a refusal", async () => {
    const ids = [
      ...Array.from({ length: 200 }, () => fx.med.dolo),
      ...Array.from({ length: 200 }, () => fx.med.crocin),
      ...Array.from({ length: 200 }, () => fx.med.augmentin),
      "", "", "",
    ];
    expect(ids.length).toBeGreaterThan(MAX_IDS);

    const out = await medicinesByIds(db, ids);
    expect(out.size).toBe(3);
    // A duplicate id must not become a duplicate ENTRY, and the empty string must not become a key
    // — a `Map` keyed on `""` is the shape that makes `out.get(line.medicineId ?? "")` look like a
    // hit at the one call site that most needs a miss.
    expect(out.has("")).toBe(false);
    expect(out.get(fx.med.dolo)!.brandName).toBe("Dolo 650");
  });

  /**
   * NOTHING TO ASK ABOUT MEANS NO QUESTION IS ASKED. Both the empty list and a list of nothing but
   * empty strings collapse to the same known answer, and `NEVER_QUERIED` is what proves the
   * round trip did not happen — see its comment for why a real handle cannot show this.
   *
   * It matters because `getDispense` is the return value of EVERY pharmacy mutation: a dispense
   * with no resolved medicine ids would otherwise pay a statement per call to be told nothing.
   */
  it("answers an empty request — and a request of only empty strings — without touching the database", async () => {
    await expect(medicinesByIds(NEVER_QUERIED, [])).resolves.toEqual(new Map());
    await expect(medicinesByIds(NEVER_QUERIED, ["", "", ""])).resolves.toEqual(new Map());
  });

  /**
   * ═══ `too_many_ids` IS A 400, AND THAT MAPPING IS WHY THE REFUSAL IS WORTH MAKING ═══
   *
   * This case lives here rather than in `masters.test.ts` because the code and its status are one
   * fact with the refusal above, and they are only useful together. An oversized list is a defect
   * in the CALLER — the request could not have been served whatever the database held — so it is
   * neither 404 ("the catalogue lacks this row", which would send a pharmacist hunting for a
   * medicine that is there) nor 409 ("some state is in the way", which invites a retry that will
   * never succeed).
   *
   * And it is above all NOT a 500. Plan 09 shipped exactly that bug: a `MembershipError` fell
   * through `toHttp`, and a correct refusal reached a busy counter as a server error with no
   * message. The assertion is made against the code carried by a REAL refusal from `reads.ts`, not
   * against the string literal, so the two halves of the seam are pinned as one.
   */
  it("maps too_many_ids to 400 — a fixable refusal, not a 404, a 409, or a 500", async () => {
    const thrown = await medicinesByIds(db, padding(MAX_IDS + 1, "MED")).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(FormularyError);
    const status = formularyHttpStatus((thrown as FormularyError).code);
    expect(status).toBe(400);
    expect(status).not.toBe(404);
    expect(status).not.toBe(409);
    expect(status).toBeLessThan(500);

    // The contrast is the whole content of the mapping: these three codes are the three answers.
    expect(formularyHttpStatus("unknown_medicine")).toBe(404);
    expect(formularyHttpStatus("duplicate_name")).toBe(409);
  });

  // ───────────────────────────────────── saltsByIds ─────────────────────────────────────

  /**
   * The same three promises over moieties. The deactivated one is asked for deliberately: an
   * allergy check and a duplicate-therapy check both reason about the moiety of a drug that is
   * already IN the patient's hand, and a curator deactivating "metformin" tomorrow cannot be
   * allowed to make today's prescription unreadable.
   */
  it("returns the named moieties, including a deactivated one, and nothing else", async () => {
    const ghost = "01HGONESALT00000000000000001";
    const out = await saltsByIds(db, [fx.salt.paracetamol, fx.salt.metformin, ghost]);
    expect(out.size).toBe(2);
    expect(out.get(fx.salt.paracetamol)!.name).toBe("paracetamol");
    expect(out.get(fx.salt.paracetamol)!.aliases).toEqual(["acetaminophen"]);
    expect(out.get(fx.salt.paracetamol)!.drugClass).toBe("analgesic-antipyretic");
    expect(out.get(fx.salt.metformin)!.active).toBe(false);
    expect(out.has(ghost)).toBe(false);
  });

  /**
   * THE SAME BOUND, PINNED SEPARATELY. `saltsByIds` shares `requireBounded` today, and that is
   * exactly why it needs its own case: a refactor that inlines the check into `medicinesByIds`,
   * or gives this one a "salts are cheap, let them through" exemption, is invisible to every
   * assertion above. The bound is a promise of the FUNCTION, not of the helper it happens to call.
   */
  it(`refuses ${String(MAX_IDS + 1)} moiety ids with too_many_ids, and accepts exactly ${String(MAX_IDS)}`, async () => {
    await expect(saltsByIds(db, padding(MAX_IDS + 1, "SLT"))).rejects.toMatchObject({
      code: "too_many_ids", detail: { asked: MAX_IDS + 1, limit: MAX_IDS },
    });
    const ok = await saltsByIds(db, [fx.salt.amoxicillin, ...padding(MAX_IDS - 1, "SLT")]);
    expect(ok.size).toBe(1);
    expect(ok.get(fx.salt.amoxicillin)!.name).toBe("amoxicillin");
  });

  it("answers an empty moiety request without touching the database", async () => {
    await expect(saltsByIds(NEVER_QUERIED, [])).resolves.toEqual(new Map());
    await expect(saltsByIds(NEVER_QUERIED, ["", ""])).resolves.toEqual(new Map());
  });

  // ──────────────────────────────────── medicineExists ────────────────────────────────────

  /**
   * `medicineExists` is the probe `modules/materials` uses to validate `items.formulary_medicine_id`
   * without importing the formulary's tables. It answers "does this id name a row", and the
   * deactivated brand is the case that says so: an item on the shelf whose brand was withdrawn
   * from the formulary this morning must not suddenly fail item validation — the stock is still
   * physically in the store, and the row is still the right link for it.
   */
  it("is true for a medicine the catalogue has, including one that has been deactivated", async () => {
    expect(await medicineExists(db, fx.med.crocin)).toBe(true);
    expect(await medicineExists(db, fx.med.glycomet)).toBe(true);
  });

  /** Absent is absent here too — and `false` must depend on the id, not merely on the table. */
  it("is false for an id the catalogue does not have", async () => {
    expect(await medicineExists(db, "01HGONEMEDICINE000000000001")).toBe(false);
    // Asked with a SALT id: the right shape, the wrong table. A probe that answered `true` here
    // would let `registerItem` link a drug item to a moiety and call it a medicine.
    expect(await medicineExists(db, fx.salt.paracetamol)).toBe(false);
  });

  /**
   * THE EMPTY ID IS ANSWERED WITHOUT ASKING. `items.formulary_medicine_id` is nullable and the
   * calling code coalesces; `""` reaching here is "no medicine named", which is knowable without
   * Postgres. The guard also stops an unindexed `= ''` probe running once per item on an import.
   */
  it("is false for the empty id, without touching the database", async () => {
    expect(await medicineExists(NEVER_QUERIED, "")).toBe(false);
  });
});

/**
 * THE ALLERGY FIELD'S AUTOCORRECT, now owned by the formulary (it was raw SQL in `cds/allergens.ts`).
 * The ranking is the one the field shipped with; the `%` handling is new and is the house rule.
 */
describe("suggestMoieties", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const salt = async (name: string): Promise<string> => (await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name }))).saltId;

  it("corrects a misspelling, ranks a prefix first, and leaves out a withdrawn moiety", async () => {
    const penicillin = await salt("penicillin G");
    const amox = await salt("amoxicillin");
    const withdrawn = await salt("penicillamine");
    await withTx(db, (tx) => updateSalt(tx, PHARMACIST, withdrawn, { active: false }));

    const misspelt = await suggestMoieties(db, "pencilin", 5);
    expect(misspelt[0]?.id).toBe(penicillin);
    expect(misspelt.map((m) => m.id)).not.toContain(withdrawn);
    expect((await suggestMoieties(db, "amox", 5))[0]?.id).toBe(amox);
  });

  it("treats a typed % or _ as a character, not a wildcard", async () => {
    await salt("amoxicillin");
    await salt("paracetamol");

    expect(await suggestMoieties(db, "%", 20)).toEqual([]);
    expect(await suggestMoieties(db, "_", 20)).toEqual([]);
  });

  it("answers nothing for nothing, and never more than twenty", async () => {
    for (const n of Array.from({ length: 25 }, (_, i) => `sodium salt ${String(i).padStart(2, "0")}`)) await salt(n);

    expect(await suggestMoieties(db, "  ", 10)).toEqual([]);
    expect(await suggestMoieties(db, "sodium", 500)).toHaveLength(20);
  });
});
