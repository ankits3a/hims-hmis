import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyMedicines, itemPriceRegulations } from "../../kernel/db/schema";
import { MaterialsError } from "./errors";
import {
  addBarcode, addItemUom, effectiveRegulation, getItem, itemUomRows, listItems, registerItem,
  resolveBarcode, setPriceRegulation, updateItem,
} from "./items";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T3 — the item master.
 *
 * Every fixture is a real article a hospital actually stocks, for `masters.test.ts`'s reason: a
 * suite green over invented data proves the plumbing and nothing else.
 *
 * ═══ THE FIXTURES DIFFER ON PURPOSE (§2.102, and this phase's standing note) ═══
 *
 * The note names six coincidences that hide defects, and three of them bite in this task:
 *   · `qty_in_uom = qty_base` (multiplier 1) — so **no fixture here gives a non-base unit a
 *     multiplier of 1**, and A2's pair gives two items a `box` of DIFFERENT sizes.
 *   · one UoM per item — so the tablet fixture carries three.
 *   · `mrp = cost` — money is T6's, but `effectiveRegulation` is asked with TWO rows that differ.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

async function eventsNamed(db: Db, name: string): Promise<{ payload: unknown }[]> {
  return db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
}

describe("the item master (Plan 14 T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); medicineSeq = 0; });

  /**
   * A formulary medicine, built by this suite rather than assumed. **Spike Q2 measured
   * `formulary_medicines` at ZERO rows in production**, so every drug-class fixture in this phase
   * has to create its own — which is the plan's instruction and also the honest state of the world.
   */
  let medicineSeq = 0;
  async function medicine(brand?: string): Promise<string> {
    const id = newId();
    // `formulary_medicines_brand_lower_ux` is unique on the brand, so a test needing TWO medicines
    // needs two brands. The counter is per-test (reset in `beforeEach` alongside `truncateAll`)
    // rather than random, so a failure names the same row twice when it is re-run.
    medicineSeq += 1;
    await db.insert(formularyMedicines).values({
      id, brandName: brand ?? `Crocin 500 #${String(medicineSeq)}`, form: "tablet",
      strengthLabel: "500 mg", createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    return id;
  }

  /** Paracetamol 500: tablet base, strip of 10, box of 100. A drug, so it names a medicine. */
  async function paracetamol(): Promise<string> {
    const medicineId = await medicine();
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "CROC500", name: "Crocin 500mg tablet", class: "drug",
      formularyMedicineId: medicineId, baseUom: "tablet", batchTracked: true,
      hsnCode: "30049099", gstRateBps: 1200, shelfLifeDays: 1095, storageClass: "ambient",
      uoms: [
        { uom: "strip", toBaseMultiplier: 10, isIssueUom: true },
        { uom: "box", toBaseMultiplier: 100, isPurchaseUom: true },
      ],
      barcodes: [{ code: "8901234567890", packUom: "strip" }],
    }));
    return itemId;
  }

  // ══════════════════════════ A1 — DD3, BOTH DIRECTIONS ══════════════════════════

  /**
   * **A1, and the leg that matters is the SECOND one.** A validator checking only
   * "a drug must have a medicine" passes every drug fixture and every non-drug fixture that
   * happens not to carry one — which is all of them, until somebody pastes an id into the wrong
   * form. The plan names this explicitly: *"A drug-without-medicine input does NOT discriminate
   * (both refuse; only the error text differs)."*
   */
  it("A1: REFUSES a drug with no medicine, and a NON-DRUG that names one", async () => {
    const medicineId = await medicine();

    await expect(withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "NOMED", name: "a drug with no medicine", class: "drug",
      baseUom: "tablet", batchTracked: true,
    }))).rejects.toThrow(MaterialsError);
    await expect(withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "NOMED2", name: "a drug with no medicine", class: "drug",
      baseUom: "tablet", batchTracked: true,
    }))).rejects.toThrow(/must name the formulary medicine/);

    // THE DISCRIMINATING DIRECTION: a consumable carrying a valid medicine id.
    await expect(withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GLV-M", name: "a glove that points at a medicine", class: "consumable",
      formularyMedicineId: medicineId, baseUom: "each", batchTracked: false,
    }))).rejects.toThrow(/must NOT name a formulary medicine/);

    // And the error is a CODE the screen can render, not a constraint name.
    try {
      await withTx(db, (tx) => registerItem(tx, HEAD, {
        code: "GLV-M2", name: "x", class: "consumable",
        formularyMedicineId: medicineId, baseUom: "each", batchTracked: false,
      }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("non_drug_has_medicine");
    }

    // Both legal shapes still register — a validator refusing everything would pass the legs above.
    await paracetamol();
    await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GLV-M-OK", name: "Nitrile glove M", class: "consumable",
      baseUom: "each", batchTracked: false,
    }));
    expect(await listItems(db)).toHaveLength(2);
  });

  it("A1: the pairing is re-validated on UPDATE, against the RESULT and not the patch", async () => {
    const itemId = await paracetamol();
    const medicineId = await medicine("Dolo 650");
    // Changing class to `consumable` while leaving the medicine attached is DD3's forbidden state,
    // and a patch validator that only looked at the supplied field would let it through.
    await expect(withTx(db, (tx) => updateItem(tx, HEAD, itemId, { class: "consumable" })))
      .rejects.toThrow(/must NOT name a formulary medicine/);
    // Clearing the medicine while leaving the class `drug` is the same defect from the other side.
    await expect(withTx(db, (tx) => updateItem(tx, HEAD, itemId, { formularyMedicineId: null })))
      .rejects.toThrow(/must name the formulary medicine/);
    // Moving BOTH together is legal.
    await withTx(db, (tx) => updateItem(tx, HEAD, itemId, { class: "consumable", formularyMedicineId: null }));
    expect((await getItem(db, itemId))?.class).toBe("consumable");
    // …and back again, to the OTHER medicine.
    await withTx(db, (tx) => updateItem(tx, HEAD, itemId, { class: "drug", formularyMedicineId: medicineId }));
    expect((await getItem(db, itemId))?.formularyMedicineId).toBe(medicineId);
  });

  it("a drug naming a medicine that does not exist is a CODE, not a foreign-key error", async () => {
    await expect(withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GHOST", name: "points at nothing", class: "drug",
      formularyMedicineId: newId(), baseUom: "tablet", batchTracked: true,
    }))).rejects.toThrow(/formulary medicine .* not found/);
  });

  // ══════════════════════════ A3 — ONE BASE UNIT, AND IT IS `base_uom` ══════════════════════════

  /**
   * **A3.** `registerItem` creates the base row itself with multiplier 1, and `addItemUom` refuses
   * a second. The mutant accepts any positive multiplier, which gives an item two bases — and then
   * `toBase` has two answers depending on which row it finds first.
   */
  it("A3: exactly one unit has multiplier 1 and it is base_uom; a second is REFUSED", async () => {
    const itemId = await paracetamol();
    const uoms = await itemUomRows(db, itemId);
    expect(uoms.filter((u) => u.toBaseMultiplier === 1)).toEqual([{ uom: "tablet", toBaseMultiplier: 1 }]);
    expect(uoms).toHaveLength(3);

    // The plan's discriminating input, verbatim: a SECOND unit with multiplier 1.
    await expect(withTx(db, (tx) => addItemUom(tx, HEAD, itemId, { uom: "each", toBaseMultiplier: 1 })))
      .rejects.toThrow(/cannot have a multiplier of 1/);
    try {
      await withTx(db, (tx) => addItemUom(tx, HEAD, itemId, { uom: "piece", toBaseMultiplier: 1 }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("base_uom_required");
    }

    // The OTHER half of the same invariant: the base unit's own multiplier may not be anything else.
    await expect(withTx(db, (tx) => addItemUom(tx, HEAD, itemId, { uom: "tablet", toBaseMultiplier: 5 })))
      .rejects.toThrow(/must be 1/);

    // A legitimate additional unit still lands — the guard is not simply refusing everything.
    await withTx(db, (tx) => addItemUom(tx, HEAD, itemId, { uom: "carton", toBaseMultiplier: 1000 }));
    expect(await itemUomRows(db, itemId)).toHaveLength(4);
    // …and still exactly one base.
    expect((await itemUomRows(db, itemId)).filter((u) => u.toBaseMultiplier === 1)).toHaveLength(1);
  });

  it("a unit name repeated on one item is refused case-insensitively", async () => {
    const itemId = await paracetamol();
    await expect(withTx(db, (tx) => addItemUom(tx, HEAD, itemId, { uom: "BOX", toBaseMultiplier: 50 })))
      .rejects.toThrow(/already has a unit named/);
  });

  it("REFUSES a non-positive multiplier before the database has to", async () => {
    const itemId = await paracetamol();
    await expect(withTx(db, (tx) => addItemUom(tx, HEAD, itemId, { uom: "void", toBaseMultiplier: 0 })))
      .rejects.toThrow(/positive integer/);
  });

  // ══════════════════════════ A4 — THE EFFECTIVE REGULATION, AND ITS TIE-BREAK ══════════════════════════

  /**
   * **A4, and the plan's own mutant for it SURVIVED — the row is corrected in the phase document
   * and the correction is worth reading before trusting this leg.**
   *
   * The fixture is the plan's and it is right: two rows with the SAME `effective_from` and
   * different ceilings, inserted in order. The shipped code returns the SECOND, by `seq`.
   *
   * What the plan got wrong is the MUTANT. It named *"a query ordered by `effective_from` only"*
   * and predicted *"the mutant returns either"*. Executed on this host at 2, 3 and 5 tied rows, the
   * missing-key mutant returned **the same row as the shipped code every time** — Postgres's top-N
   * sort kept insertion order, and `ORDER BY` on a tie is PERMITTED to return either, so agreeing is
   * within its rights. **A missing tie-break is therefore not observably wrong, only unreliably
   * right, and no assertion over the returned row can kill it.** What this leg DOES kill,
   * deterministically, is a tie-break that is present and BACKWARDS (`asc(seq)`): that mutant
   * returned the first row where the shipped code returns the second.
   *
   * The consequence for a reader: the `desc(seq)` in `effectiveRegulation` is load-bearing and this
   * test cannot prove it is there. It can only prove that IF a tie-break exists it points the right
   * way. The absence is guarded by the docstring on `effectiveRegulation` and by review, not by
   * this assertion — which is exactly the kind of thing worth saying out loud rather than leaving a
   * green tick to imply otherwise.
   */
  it("A4: same effective_from, different ceilings — the LATER-INSERTED row wins, by seq", async () => {
    const itemId = await paracetamol();
    const sameInstant = new Date("2026-04-01T00:00:00Z");

    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 900, mrpDefaultPaise: 8500, mrpUom: "strip",
      effectiveFrom: sameInstant, gazetteRef: "NPPA/2026/first",
    }));
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 750, mrpDefaultPaise: 7500, mrpUom: "strip",
      effectiveFrom: sameInstant, gazetteRef: "NPPA/2026/correction",
    }));

    const at = await effectiveRegulation(db, itemId, sameInstant);
    expect(at?.ceilingPaise).toBe(750);
    expect(at?.gazetteRef).toBe("NPPA/2026/correction");
    // …and still the correction a month later, where the date key is still tied.
    expect((await effectiveRegulation(db, itemId, new Date("2026-05-01T00:00:00Z")))?.ceilingPaise).toBe(750);
  });

  it("A4 control: different dates — the latest one at or before `at`, and NOTHING before the first", async () => {
    const itemId = await paracetamol();
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 900, mrpUom: "strip", effectiveFrom: new Date("2026-01-01T00:00:00Z"), gazetteRef: "g1",
    }));
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 750, mrpUom: "strip", effectiveFrom: new Date("2026-06-01T00:00:00Z"), gazetteRef: "g2",
    }));
    expect((await effectiveRegulation(db, itemId, new Date("2026-03-01T00:00:00Z")))?.ceilingPaise).toBe(900);
    expect((await effectiveRegulation(db, itemId, new Date("2026-07-01T00:00:00Z")))?.ceilingPaise).toBe(750);
    // A future regulation is NOT in force — the `<=` is on `effective_from`, not on `now`.
    expect(await effectiveRegulation(db, itemId, new Date("2025-12-31T00:00:00Z"))).toBeUndefined();
    // The boundary itself is INCLUSIVE: a gazette effective at midnight is in force at midnight.
    expect((await effectiveRegulation(db, itemId, new Date("2026-06-01T00:00:00Z")))?.ceilingPaise).toBe(750);
  });

  it("regulations are APPEND-ONLY: a second row for one item leaves the first standing", async () => {
    const itemId = await paracetamol();
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 900, mrpUom: "strip", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    }));
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 750, mrpUom: "strip", effectiveFrom: new Date("2026-06-01T00:00:00Z"),
    }));
    const all = await db.select().from(itemPriceRegulations).where(eq(itemPriceRegulations.itemId, itemId));
    expect(all).toHaveLength(2);
  });

  /**
   * ═══ CLOSE REVIEW M4 — THE PAIR RULE APPLIES TO THE **CEILING**, AND DID NOT ═══
   *
   * `setPriceRegulation` enforced "paise never travels without its unit" for `mrpDefaultPaise` and
   * not for `ceilingPaise`. A DPCO ceiling entered as `{ ceilingPaise: 800 }` with no `mrpUom` was
   * accepted, and `grn.ts` then **fell back to the BASE unit** — reading ₹8.00-per-strip as 800
   * paise per TABLET.
   *
   * **DD8 rule 7 — which DD8 itself calls "the cheapest place to stop selling above a notified
   * ceiling" — therefore failed OPEN by the pack multiplier**, tenfold on a strip of ten, silently.
   * A gate that fails open is worse than no gate, because it is believed.
   *
   * Two legs in this very file were relying on the hole: `A4 control` and the append-only leg both
   * set a ceiling with no unit and passed. Both now carry `mrpUom: "strip"`, which is what a real
   * gazette carries. **A fixture that only compiles because a guard is missing is the guard's
   * absence, written down** — and neither leg noticed, because neither was about units.
   */
  it("M4: a CEILING without its unit is refused — the pair rule is not just for the MRP", async () => {
    const itemId = await paracetamol();
    await expect(withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 800, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    }))).rejects.toMatchObject({ code: "unknown_uom" });
    // WITH its unit it is accepted, and the unit is stored so the gate can convert it.
    await withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 800, mrpUom: "strip", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    }));
    const reg = await effectiveRegulation(db, itemId, new Date("2026-02-01T00:00:00Z"));
    expect({ ceilingPaise: reg?.ceilingPaise, mrpUom: reg?.mrpUom })
      .toEqual({ ceilingPaise: 800, mrpUom: "strip" });
    // And a unit that is not one of THIS item's is still refused, ceiling or no ceiling (A2).
    await expect(withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      ceilingPaise: 800, mrpUom: "drum", effectiveFrom: new Date("2026-03-01T00:00:00Z"),
    }))).rejects.toMatchObject({ code: "unknown_uom" });
  });

  it("an MRP on a regulation needs its unit, and the unit must be the item's", async () => {
    const itemId = await paracetamol();
    await expect(withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      mrpDefaultPaise: 8500, effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    }))).rejects.toThrow(/no unit/);
    await expect(withTx(db, (tx) => setPriceRegulation(tx, HEAD, itemId, {
      mrpDefaultPaise: 8500, mrpUom: "pallet", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    }))).rejects.toThrow(/not one of this item's units/);
  });

  // ══════════════════════════ the masks: create, update, list, resolve ══════════════════════════

  it("registers an item with its units and barcodes, and emits ONE item.registered", async () => {
    const itemId = await paracetamol();
    const item = await getItem(db, itemId);
    expect(item?.code).toBe("CROC500");
    expect(item?.baseUom).toBe("tablet");
    expect(item?.gstRateBps).toBe(1200);
    expect(item?.uoms.map((u) => u.uom)).toEqual(["tablet", "strip", "box"]);
    expect(item?.barcodes).toHaveLength(1);
    // ONE event for one act — five units must not produce six events.
    const registered = await eventsNamed(db, "item.registered");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.payload).toMatchObject({
      itemId, code: "CROC500", itemClass: "drug", baseUom: "tablet",
    });
    // …and no `item.updated` at all from a registration.
    expect(await eventsNamed(db, "item.updated")).toHaveLength(0);
  });

  it("updates emit ONE item.updated naming the changed FIELDS, never their values", async () => {
    const itemId = await paracetamol();
    await withTx(db, (tx) => updateItem(tx, HEAD, itemId, { name: "Crocin 500 mg tab", abcClass: "A" }));
    const updated = await eventsNamed(db, "item.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.payload).toMatchObject({ itemId });
    expect((updated[0]?.payload as { changed: string[] }).changed.sort()).toEqual(["abcClass", "name"]);
    // A no-op patch writes nothing at all — an event describing no change is noise in the stream.
    await withTx(db, (tx) => updateItem(tx, HEAD, itemId, {}));
    expect(await eventsNamed(db, "item.updated")).toHaveLength(1);
  });

  it("a duplicate item code is refused case-insensitively, with a code", async () => {
    await paracetamol();
    const medicineId = await medicine("Calpol 500");
    try {
      await withTx(db, (tx) => registerItem(tx, HEAD, {
        code: "croc500", name: "a second Crocin", class: "drug",
        formularyMedicineId: medicineId, baseUom: "tablet", batchTracked: true,
      }));
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as MaterialsError).code).toBe("duplicate_code");
    }
  });

  it("a barcode resolves to its item AND the pack it is on; a code is globally unique", async () => {
    const itemId = await paracetamol();
    expect(await resolveBarcode(db, "8901234567890")).toEqual({ itemId, packUom: "strip" });
    // Case-insensitive, because a scanner and a keyboard disagree about case.
    expect(await resolveBarcode(db, "8901234567890 ")).toEqual({ itemId, packUom: "strip" });
    expect(await resolveBarcode(db, "nope")).toBeUndefined();

    // A barcode on a pack the item does not have is refused: the scan would resolve to a quantity
    // nobody can compute.
    await expect(withTx(db, (tx) => addBarcode(tx, HEAD, itemId, { code: "999", packUom: "pallet" })))
      .rejects.toThrow(/not one of this item's units/);

    // GLOBAL uniqueness — a scanner does not know which item it is about to read.
    const gloves = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GLV-M", name: "Nitrile glove M", class: "consumable", baseUom: "each", batchTracked: false,
    }));
    await expect(withTx(db, (tx) => addBarcode(tx, HEAD, gloves.itemId, {
      code: "8901234567890", packUom: "each",
    }))).rejects.toThrow(/already belongs to an item/);
  });

  it("lists by class, by active flag and by search over code or name", async () => {
    await paracetamol();
    const gloves = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GLV-M", name: "Nitrile glove M", class: "consumable", baseUom: "each", batchTracked: false,
    }));
    expect((await listItems(db, { class: "drug" })).map((i) => i.code)).toEqual(["CROC500"]);
    expect((await listItems(db, { search: "glove" })).map((i) => i.code)).toEqual(["GLV-M"]);
    expect((await listItems(db, { search: "CROC" })).map((i) => i.code)).toEqual(["CROC500"]);
    await withTx(db, (tx) => updateItem(tx, HEAD, gloves.itemId, { active: false }));
    expect((await listItems(db, { active: true })).map((i) => i.code)).toEqual(["CROC500"]);
    expect(await listItems(db)).toHaveLength(2);
  });

  it("unknown ids refuse with `unknown_item` rather than a foreign-key error", async () => {
    const ghost = newId();
    await expect(withTx(db, (tx) => updateItem(tx, HEAD, ghost, { name: "x" }))).rejects.toThrow(/not found/);
    await expect(withTx(db, (tx) => addItemUom(tx, HEAD, ghost, { uom: "x", toBaseMultiplier: 2 })))
      .rejects.toThrow(/not found/);
    expect(await getItem(db, ghost)).toBeUndefined();
  });
});
