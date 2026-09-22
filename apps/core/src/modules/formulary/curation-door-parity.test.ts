import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { formularyMedicineSalts } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { addInteraction, addMedicine, addSalt, updateMedicine } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE CURATION SURFACE HAS TWO DOORS, AND THEY MUST REFUSE THE SAME THINGS ═══
 *
 * `addMedicine` and `updateMedicine` both decide what a medicine's composition may be. Every guard
 * that exists on one and not the other is a way in: create the medicine in a shape `addMedicine`
 * permits, then PATCH it into the shape `addMedicine` was written to refuse.
 *
 * THIS HAS HAPPENED BEFORE ON THIS EXACT PAIR. `masters.ts`'s own C6 comment says so — "DD8 HAS TWO
 * DOORS AND ONLY ONE HAD A LOCK": `addMedicine` refused an FDC whose own salts interact,
 * `updateMedicine` accepted it silently, and creating single-salt then PATCHing the interacting pair
 * in walked straight past the gate. That instance was fixed. The CLASS was not, and this suite is
 * the class: one case per guard `addMedicine` applies, asserting the other door applies it too.
 *
 * The empty-composition case below was RED when this file was written. `addMedicine` refuses an
 * empty composition and says exactly why — "a medicine with no composition resolves to 'known, and
 * contains nothing', which C3 showed is the shape that makes a check suite go quiet while reporting
 * success ... the domain function must refuse it too, or the next caller mints one". A caller did:
 * `updateMedicine(tx, actor, id, { salts: [] })` deleted every composition row and re-inserted none,
 * because the delete at masters.ts:247 is unconditional and the re-insert at :248 is guarded by
 * `if (salts.length > 0)`. So the curation surface could mint the very row the other door refuses —
 * and the resulting medicine is one that `equivalence.ts`'s `count(want) > 0` clause then has to
 * defend the dispensing counter against.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };

describe("the two curation doors refuse the same compositions", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  /** Augmentin 625 is really amoxicillin + clavulanic acid, and they really do not interact. */
  async function seedAugmentin(): Promise<{ amox: string; clav: string; augmentin: string }> {
    const { saltId: amox } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, {
      name: "amoxicillin", aliases: ["amoxycillin"], drugClass: "penicillin",
    }));
    const { saltId: clav } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "clavulanic acid" }));
    const { medicineId: augmentin } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Augmentin 625", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg + 125 mg",
      salts: [{ saltId: amox }, { saltId: clav }],
    }));
    return { amox, clav, augmentin };
  }

  async function compositionOf(medicineId: string): Promise<string[]> {
    const rows = await db.select({ saltId: formularyMedicineSalts.saltId })
      .from(formularyMedicineSalts).where(eq(formularyMedicineSalts.medicineId, medicineId));
    return rows.map((r) => r.saltId).sort();
  }

  it("addMedicine refuses a medicine with no moiety at all", async () => {
    await expect(withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Mystery Tonic", form: "syrup", routeClass: "systemic", salts: [],
    }))).rejects.toMatchObject({ code: "unknown_salt" });
  });

  /**
   * THE CASE THIS FILE EXISTS FOR. Red before the guard: `updateMedicine` deleted both composition
   * rows, re-inserted none, appended `medicine.corrected` with an empty `toSaltIds`, and returned
   * successfully — leaving a catalogued brand that resolves to "known, and contains nothing".
   */
  it("updateMedicine refuses to empty a composition through the other door", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();

    await expect(withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { salts: [] })))
      .rejects.toBeInstanceOf(FormularyError);
    await expect(withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { salts: [] })))
      .rejects.toMatchObject({ code: "unknown_salt" });

    // The refusal must also have CHANGED NOTHING — a guard that throws after the delete has already
    // run would leave exactly the row it was written to prevent, and `rejects` alone cannot see it.
    expect(await compositionOf(augmentin)).toEqual([amox, clav].sort());
  });

  /** A real composition change is still allowed through that door — the guard refuses empty, not edit. */
  it("updateMedicine still accepts a composition that has moieties in it", async () => {
    const { amox, augmentin } = await seedAugmentin();
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { salts: [{ saltId: amox }] }));
    expect(await compositionOf(augmentin)).toEqual([amox]);
  });

  /**
   * The OTHER guard on this pair, and the one C6 added — kept here beside its sibling so the class
   * is visible in one file rather than split across two suites that nobody reads together.
   */
  it("both doors refuse an FDC whose own moieties interact, unless it is acknowledged", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const { saltId: aspirin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "aspirin" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: warfarin, saltBId: aspirin, severity: "severe", note: "bleeding risk", source: "seed-2026-08",
    }));

    await expect(withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Illadvised Duo", form: "tablet", routeClass: "systemic",
      salts: [{ saltId: warfarin }, { saltId: aspirin }],
    }))).rejects.toMatchObject({ code: "intra_fdc_interaction" });

    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Warf 5", form: "tablet", routeClass: "systemic", salts: [{ saltId: warfarin }],
    }));
    await expect(withTx(db, (tx) => updateMedicine(tx, PHARMACIST, medicineId, {
      salts: [{ saltId: warfarin }, { saltId: aspirin }],
    }))).rejects.toMatchObject({ code: "intra_fdc_interaction" });
  });
});
