import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { formularyMedicines } from "../../kernel/db/schema";
import {
  addInteraction, addMedicine, addSalt, updateInteraction, updateMedicine, updateSalt,
} from "./masters";
import { listInteractionsAmong, normalizeDrugName, resolveDrugTexts, resolveMedicines } from "./resolve";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16a T3 — the boundary OPD consumes, and the law it exists to make executable.
 *
 * ═══ DD2: FUZZY SUGGESTS, EXACT RESOLVES ═══
 *
 * The consult autocomplete may match generously — it is a picker and a human confirms what it
 * offers. `resolveDrugTexts` is the other thing entirely: it feeds SAFETY CHECKS with no human in
 * the loop, over allergy substances and legacy free-text lines nobody is looking at. A fuzzy match
 * there does not produce a slightly-wrong suggestion; it silently attaches ANOTHER DRUG'S MOIETIES
 * to a line, and every check downstream then reasons about a medicine the patient is not taking.
 *
 * So a typo resolves to `null` and falls back to the legacy substring layer. The third test below
 * pins that `null` — it is the one assertion in this file that looks like a missing feature and is
 * in fact the whole design.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };

describe("formulary resolution (Plan 16a T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  /** amoxicillin (alias "amoxycillin", class "penicillin") + clavulanic acid → Augmentin 625. */
  async function seedAugmentin(): Promise<{ amox: string; clav: string; augmentin: string }> {
    const { saltId: amox } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, {
      name: "amoxicillin", aliases: ["amoxycillin"], drugClass: "penicillin",
    }));
    const { saltId: clav } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "clavulanic acid" }));
    const { medicineId: augmentin } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Augmentin 625", form: "tablet", routeClass: "systemic",
      salts: [{ saltId: amox, strength: "500 mg" }, { saltId: clav, strength: "125 mg" }],
    }));
    return { amox, clav, augmentin };
  }

  // ─────────────────────────────── the normalizer ───────────────────────────────

  it("normalizes case, edge whitespace, inner whitespace runs and the punctuation set", () => {
    expect(normalizeDrugName("  Augmentin   625  ")).toBe("augmentin 625");
    expect(normalizeDrugName("Co-Amoxiclav (625)")).toBe("coamoxiclav 625");
    expect(normalizeDrugName("Vitamin B.12")).toBe("vitamin b12");
    expect(normalizeDrugName("Salt/Base")).toBe("saltbase");
    // Idempotent: normalizing an already-normalized name changes nothing.
    expect(normalizeDrugName(normalizeDrugName("Co-Amoxiclav (625)"))).toBe("coamoxiclav 625");
  });

  // ─────────────────────── resolution: brand → moiety → alias, exactly ───────────────────────

  /**
   * THE AUGMENTIN CASE, from the resolution side. A brand must carry its whole composition or the
   * allergy check has nothing to match a "penicillin" allergy against.
   */
  it("a brand resolves to its composition, with class carried per moiety", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();
    const resolved = await resolveDrugTexts(db, ["Augmentin 625"]);
    const drug = resolved.get("Augmentin 625");
    expect(drug).not.toBeNull();
    expect(drug!.medicineId).toBe(augmentin);
    expect(drug!.brandName).toBe("Augmentin 625");
    expect(drug!.routeClass).toBe("systemic");
    expect(drug!.salts.map((s) => s.saltId).sort()).toEqual([amox, clav].sort());
    const amoxRef = drug!.salts.find((s) => s.saltId === amox)!;
    expect({ moiety: amoxRef.moiety, drugClass: amoxRef.drugClass })
      .toEqual({ moiety: "amoxicillin", drugClass: "penicillin" });
  });

  it("a brand resolves through the normalizer, not through its stored spelling", async () => {
    await seedAugmentin();
    for (const text of ["augmentin 625", "AUGMENTIN 625", "  Augmentin   625 "]) {
      expect(await resolveDrugTexts(db, [text]).then((m) => m.get(text)?.brandName)).toBe("Augmentin 625");
    }
  });

  it("a moiety name resolves to itself, with no medicine attached", async () => {
    const { amox } = await seedAugmentin();
    const drug = (await resolveDrugTexts(db, ["Amoxicillin"])).get("Amoxicillin");
    expect(drug).not.toBeNull();
    expect({ medicineId: drug!.medicineId, brandName: drug!.brandName, routeClass: drug!.routeClass })
      .toEqual({ medicineId: null, brandName: null, routeClass: null });
    expect(drug!.salts.map((s) => s.saltId)).toEqual([amox]);
  });

  it("a recorded alias resolves to the moiety it is an alias of", async () => {
    const { amox } = await seedAugmentin();
    const drug = (await resolveDrugTexts(db, ["amoxycillin"])).get("amoxycillin");
    expect(drug).not.toBeNull();
    expect(drug!.salts.map((s) => s.saltId)).toEqual([amox]);
    expect(drug!.medicineId).toBeNull();
  });

  /**
   * THE DD2 LAW, MADE EXECUTABLE. `null` is the assertion. An implementation that "helpfully"
   * matched by substring or edit distance would pass every other test in this file and fail here,
   * which is the only reason this row is worth its line.
   */
  it("a typo resolves to NULL — no substring, no distance, no near-enough", async () => {
    await seedAugmentin();
    const texts = ["Augmentn", "Augmentin", "amoxicilin", "amox", "625"];
    const resolved = await resolveDrugTexts(db, texts);
    for (const text of texts) {
      expect({ text, drug: resolved.get(text) ?? null }).toEqual({ text, drug: null });
    }
  });

  it("an unresolvable substance is a null, never an empty-salts drug — the two mean different things", async () => {
    await seedAugmentin();
    // `adrak` (ginger) and `dust` are real production allergy substances, measured 2026-08-26.
    // Neither is a drug; both must fall to the legacy substring layer, and a caller can only tell
    // that from `null`. An empty-salts ResolvedDrug would read as "resolved, and it contains
    // nothing", which is how a check suite silently stops checking.
    const resolved = await resolveDrugTexts(db, ["adrak", "dust", ""]);
    expect(resolved.get("adrak")).toBeNull();
    expect(resolved.get("dust")).toBeNull();
    expect(resolved.get("")).toBeNull();
  });

  it("resolves a batch in one call, keyed by the caller's own strings", async () => {
    const { amox } = await seedAugmentin();
    const resolved = await resolveDrugTexts(db, ["Augmentin 625", "amoxycillin", "Augmentn"]);
    expect(resolved.size).toBe(3);
    expect(resolved.get("Augmentin 625")!.brandName).toBe("Augmentin 625");
    expect(resolved.get("amoxycillin")!.salts.map((s) => s.saltId)).toEqual([amox]);
    expect(resolved.get("Augmentn")).toBeNull();
  });

  // ─────────────────────────────── inactive is invisible ───────────────────────────────

  it("a deactivated medicine and a deactivated moiety both stop resolving", async () => {
    const { amox, augmentin } = await seedAugmentin();
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { active: false }));
    expect((await resolveDrugTexts(db, ["Augmentin 625"])).get("Augmentin 625")).toBeNull();
    expect((await resolveMedicines(db, [augmentin])).get(augmentin)).toBeUndefined();

    await withTx(db, (tx) => updateSalt(tx, PHARMACIST, amox, { active: false }));
    expect((await resolveDrugTexts(db, ["amoxicillin"])).get("amoxicillin")).toBeNull();
    expect((await resolveDrugTexts(db, ["amoxycillin"])).get("amoxycillin")).toBeNull();
  });

  /**
   * C3 (independent review, CRITICAL) — DEACTIVATING A MOIETY MUST NOT EMPTY THE COMPOSITION OF
   * EVERY MEDICINE CONTAINING IT.
   *
   * The shipped test above asserts only that the SALT'S OWN NAME stops resolving, and passed
   * throughout. What it could not see: `compositionOf` filtered the composition through the ACTIVE
   * salts, so a live medicine whose moiety had been deactivated resolved to `salts: []` — "known,
   * and contains nothing". Every salt-aware check then found nothing and the line reported as
   * checked and covered. `active` on a salt means NOT STOCKED; it has never meant NOT A SUBSTANCE.
   */
  it("a deactivated moiety stays in the composition of the medicines that contain it", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();
    await withTx(db, (tx) => updateSalt(tx, PHARMACIST, amox, { active: false }));

    const drug = (await resolveDrugTexts(db, ["Augmentin 625"])).get("Augmentin 625");
    expect(drug).not.toBeNull();
    // The composition is COMPLETE. An allergy to amoxicillin still has something to match against.
    expect(drug!.salts.map((s) => s.saltId).sort()).toEqual([amox, clav].sort());
    expect(drug!.salts.find((s) => s.saltId === amox)!.drugClass).toBe("penicillin");
    // Same through the id path, which 16b's dispense will use.
    expect((await resolveMedicines(db, [augmentin])).get(augmentin)!.salts).toHaveLength(2);

    // And the moiety's own NAME still does not resolve — deactivation means "not offered", which is
    // the behaviour the test above pins and this one deliberately leaves alone.
    expect((await resolveDrugTexts(db, ["amoxicillin"])).get("amoxicillin")).toBeNull();
  });

  it("a medicine keeps resolving by id for a line that already carries one", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();
    const byId = await resolveMedicines(db, [augmentin, "01HNOSUCH000000000000000001"]);
    expect(byId.size).toBe(1);
    const drug = byId.get(augmentin)!;
    expect(drug.brandName).toBe("Augmentin 625");
    expect(drug.salts.map((s) => s.saltId).sort()).toEqual([amox, clav].sort());
  });

  // ─────────────────────────────── the pairs the check engine reads ───────────────────────────────

  it("lists only pairs whose BOTH moieties are present, and skips inactive ones", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const { saltId: aspirin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, {
      name: "aspirin", drugClass: "nsaid",
    }));
    const { saltId: paracetamol } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: warfarin, saltBId: aspirin, severity: "severe",
      note: "bleeding risk — avoid or monitor INR closely", source: "seed-2026-08",
    }));
    const { interactionId: retired } = await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: warfarin, saltBId: paracetamol, severity: "moderate",
      note: "INR rise on sustained use", source: "manual",
    }));

    const both = await listInteractionsAmong(db, [warfarin, aspirin]);
    expect(both).toHaveLength(1);
    expect({ severity: both[0]!.severity, routeScope: both[0]!.routeScope })
      .toEqual({ severity: "severe", routeScope: null });
    expect(both[0]!.note).toBe("bleeding risk — avoid or monitor INR closely");

    // One side present is not a pair: the patient is not taking the other drug.
    expect(await listInteractionsAmong(db, [warfarin])).toHaveLength(0);
    expect(await listInteractionsAmong(db, [])).toHaveLength(0);

    // A curator retiring a pair takes it out of the check engine's view immediately.
    await withTx(db, (tx) => updateInteraction(tx, PHARMACIST, retired, { active: false }));
    expect(await listInteractionsAmong(db, [warfarin, paracetamol])).toHaveLength(0);
    expect(await listInteractionsAmong(db, [warfarin, aspirin])).toHaveLength(1);
  });

  it("carries route scope through, because the check engine filters on it", async () => {
    const { saltId: diclofenac } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, {
      name: "diclofenac", drugClass: "nsaid",
    }));
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: diclofenac, saltBId: warfarin, severity: "severe",
      note: "bleeding risk when systemic", source: "seed-2026-08", routeScope: "systemic_only",
    }));
    const [pair] = await listInteractionsAmong(db, [diclofenac, warfarin]);
    expect(pair!.routeScope).toBe("systemic_only");
  });
  /**
   * ═══ THE STORED KEY AND THE TYPESCRIPT NORMALIZER MUST AGREE, OR THE SAFETY HALF GOES QUIET ═══
   *
   * `name_normalized` is filled by `normalizeDrugName` at every write site, and ONCE in SQL — the
   * backfill in migration 0095, for rows that existed before the column. `resolve.ts`'s own header
   * says why that is the dangerous shape: "§2.54 is the entry that says two copies of one fact
   * drift by construction. The drift would be silent and one-directional: a brand with a hyphen
   * would resolve in one path and not the other, and the half that stops resolving is the SAFETY
   * half."
   *
   * This is the answer to that objection, and it has to be a test rather than an argument. The
   * corpus is adversarial on purpose: every character class the normalizer touches — the punctuation
   * it strips, doubled spaces, leading and trailing space, and case.
   */
  it("the stored key and the TypeScript normalizer agree on every shape the normalizer touches", async () => {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "amoxicillin" }));
    const brands = [
      "Augmentin-625",
      "Co.Amoxiclav (625)",
      "Amox  /  Clav",
      "  Crocin , 500  ",
      "PARACETAMOL",
      "A-Ret 0.025%",
    ];
    for (const brandName of brands) {
      await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName, form: "tablet", routeClass: "systemic", salts: [{ saltId }],
      }));
    }

    const rows = await db.select({
      brandName: formularyMedicines.brandName, stored: formularyMedicines.nameNormalized,
    }).from(formularyMedicines);

    expect(rows).toHaveLength(brands.length);
    for (const row of rows) {
      expect(row.stored).toBe(normalizeDrugName(row.brandName));
    }
  });

  /**
   * AND THE RESOLVER MUST USE IT. A doctor types "Augmentin 625"; the catalogue holds
   * "Augmentin (625)". Those are one drug and the normalizer is what says so — but only if the
   * WHERE clause reads the stored key rather than the raw brand name.
   *
   * THE PAIR IS CHOSEN, NOT ASSUMED. `normalizeDrugName` REMOVES `. , ( ) - /` — it does not
   * substitute a space for them — so "Augmentin (625)" normalizes to "augmentin 625" (the space
   * survives the brackets) while "Augmentin-625" normalizes to "augmentin625" and does NOT match
   * "Augmentin 625". The first version of this test asserted the hyphen case and failed, correctly.
   * That is also exactly what the 51 colliding groups on the real catalogue look like: `A-Pan` and
   * `Apan` collapse together, `A-Pan` and `A Pan` do not.
   */
  it("resolves a brand written with punctuation the stored key strips", async () => {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "amoxicillin" }));
    await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Augmentin (625)", form: "tablet", routeClass: "systemic", salts: [{ saltId }],
    }));

    const out = await resolveDrugTexts(db, ["Augmentin 625"]);
    expect(out.get("Augmentin 625")?.brandName).toBe("Augmentin (625)");
    expect(out.get("Augmentin 625")?.salts.map((s) => s.moiety)).toEqual(["amoxicillin"]);
  });

  /** A RENAME RE-NORMALIZES. Otherwise the row keeps resolving under its OLD name, silently. */
  it("re-normalizes when a brand is renamed, so the row resolves under the new name and not the old", async () => {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "amoxicillin" }));
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Novamox-500", form: "capsule", routeClass: "systemic", salts: [{ saltId }],
    }));
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, medicineId, { brandName: "Mox 500" }));

    expect((await resolveDrugTexts(db, ["Mox 500"])).get("Mox 500")?.brandName).toBe("Mox 500");
    // The OLD name, spelled the way that DID resolve before the rename — "Novamox-500" normalizes
    // to "novamox500", which is the stored key that has just been replaced. Asserting the
    // space-spelled "Novamox 500" instead would pass vacuously: it never matched either.
    expect((await resolveDrugTexts(db, ["Novamox-500"])).get("Novamox-500")).toBeNull();
  });

});
