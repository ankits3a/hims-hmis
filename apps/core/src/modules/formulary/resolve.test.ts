import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
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
});
