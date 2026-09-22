import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import {
  addInteraction, addMedicine, addSalt, updateInteraction, updateMedicine, updateSalt,
} from "./masters";
import { catalogueCensus, medicinesByIds, pageInteractions, pageSalts, saltsByIds } from "./reads";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16a T2 — the formulary masters.
 *
 * Every fixture is a REAL pharmacological fact (Augmentin IS amoxicillin + clavulanic acid;
 * warfarin × aspirin IS a severe pair), because a test suite that is green over invented
 * pharmacology proves the plumbing and nothing else — and this module's whole purpose is that the
 * data means something.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };

async function eventsNamed(db: Db, name: string): Promise<{ payload: unknown }[]> {
  return db.select({ payload: events.payload }).from(events).where(eq(events.name, name));
}

describe("formulary masters (Plan 16a T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  /** amoxicillin (class: penicillin) + clavulanic acid, and the brand they combine into. */
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

  /**
   * The composition of ONE medicine, by the id its write returned — and a throw if that id names no
   * row, so a vanished medicine fails as itself rather than as an empty array that quietly equals
   * whatever the caller expected.
   */
  async function compositionOf(medicineId: string): Promise<string[]> {
    const medicine = (await medicinesByIds(db, [medicineId])).get(medicineId);
    if (medicine === undefined) throw new Error(`the formulary has no medicine ${medicineId}`);
    return medicine.salts.map((s) => s.saltId);
  }

  // ────────────────────────────── composition, round trip ──────────────────────────────

  it("a brand round-trips with its moieties — the Augmentin composition, by name", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();
    // Read back BY THE ID THE WRITE RETURNED. Scanning a list for the row just written asserts
    // "some row looks like this"; naming the row asserts "THIS row is this", which is the claim.
    const medicine = (await medicinesByIds(db, [augmentin])).get(augmentin);
    expect(medicine).toBeDefined();
    expect(medicine!.brandName).toBe("Augmentin 625");
    expect(medicine!.salts.map((s) => s.saltId).sort()).toEqual([amox, clav].sort());
    expect(medicine!.salts.find((s) => s.saltId === amox)!.strength).toBe("500 mg");

    // The class that makes the Augmentin allergy case possible at all (T4 consumes it).
    const salts = await saltsByIds(db, [amox]);
    expect(salts.get(amox)!.drugClass).toBe("penicillin");
    expect(salts.get(amox)!.aliases).toEqual(["amoxycillin"]);
  });

  it("every mutation lands its event, and the event carries what a later reader needs", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();

    const added = await eventsNamed(db, "salt.added");
    expect(added).toHaveLength(2);
    const amoxPayload = added.map((e) => e.payload as { saltId: string; drugClass: string | null })
      .find((p) => p.saltId === amox);
    expect(amoxPayload!.drugClass).toBe("penicillin");

    const medicines = await eventsNamed(db, "medicine.added");
    expect(medicines).toHaveLength(1);
    const payload = medicines[0]!.payload as {
      medicineId: string; saltIds: string[]; intraFdcAcknowledged: boolean; stagingId: string | null;
    };
    expect(payload.medicineId).toBe(augmentin);
    expect([...payload.saltIds].sort()).toEqual([amox, clav].sort());
    expect(payload.intraFdcAcknowledged).toBe(false);
    expect(payload.stagingId).toBeNull();
  });

  it("a brand cannot be admitted twice, case-insensitively, and the refusal is typed", async () => {
    const { amox } = await seedAugmentin();
    await expect(
      withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "AUGMENTIN 625", form: "tablet", routeClass: "systemic",
        salts: [{ saltId: amox }],
      })),
    ).rejects.toMatchObject({ code: "duplicate_name" });
    // And the same for a moiety, which is where the damage would be worse — two rows for one
    // moiety split every check that groups by it.
    await expect(
      withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "Amoxicillin" })),
    ).rejects.toMatchObject({ code: "duplicate_name" });
  });

  it("a composition naming a moiety the formulary does not have is refused, by name", async () => {
    await expect(
      withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "Invented Brand", form: "tablet", routeClass: "systemic",
        salts: [{ saltId: "01HNOSUCHSALT00000000000001" }],
      })),
    ).rejects.toMatchObject({ code: "unknown_salt" });
    expect((await catalogueCensus(db)).medicines).toBe(0);
  });

  // ──────────────────────── the pair is one fact, whichever way it is typed ────────────────────────

  it("an interaction is stored canonically whichever order the curator gives it", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const { saltId: aspirin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, {
      name: "aspirin", drugClass: "nsaid",
    }));
    const [low, high] = warfarin < aspirin ? [warfarin, aspirin] : [aspirin, warfarin];

    // Typed the WRONG way round on purpose — `addInteraction` normalizes before insert, which is
    // what stops the schema's ordering CHECK ever being a curator's problem.
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: high, saltBId: low, severity: "severe",
      note: "bleeding risk — avoid or monitor INR closely", source: "seed-2026-08",
    }));

    const [pair] = (await pageInteractions(db)).items;
    expect({ a: pair!.saltAId, b: pair!.saltBId }).toEqual({ a: low, b: high });

    // The same fact entered again, this time the right way round, is still the same fact.
    await expect(
      withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
        saltAId: low, saltBId: high, severity: "moderate",
        note: "entered again by another curator", source: "manual",
      })),
    ).rejects.toMatchObject({ code: "duplicate_name" });

    const evs = await eventsNamed(db, "interaction.added");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload as { saltAId: string; saltBId: string }).toMatchObject({ saltAId: low, saltBId: high });
  });

  it("an interaction naming an unknown moiety is refused before anything is written", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    await expect(
      withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
        saltAId: warfarin, saltBId: "01HNOSUCHSALT00000000000001",
        severity: "severe", note: "n/a", source: "manual",
      })),
    ).rejects.toMatchObject({ code: "unknown_salt" });
    expect((await catalogueCensus(db)).interactions).toBe(0);
  });

  // ─────────────────────────────── DD8: the intra-FDC gate ───────────────────────────────

  /**
   * BOTH BRANCHES IN ONE TEST, deliberately. A test that only proved the refusal would pass
   * equally well against an implementation that refuses every FDC, and the acknowledged branch is
   * the one a pharmacist actually needs — a marketed combination whose internals interact is a
   * fact about the market, not a mistake to be blocked.
   */
  it("an FDC whose own salts interact is refused, then admitted with an acknowledgement", async () => {
    const { saltId: a } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "ciprofloxacin" }));
    const { saltId: b } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "theophylline" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: a, saltBId: b, severity: "severe",
      note: "ciprofloxacin raises theophylline levels — toxicity risk", source: "seed-2026-08",
    }));

    const attempt = withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Invented Combination", form: "tablet", routeClass: "systemic",
      salts: [{ saltId: a }, { saltId: b }],
    }));
    await expect(attempt).rejects.toBeInstanceOf(FormularyError);
    await expect(attempt).rejects.toMatchObject({ code: "intra_fdc_interaction" });
    expect((await catalogueCensus(db)).medicines).toBe(0);

    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Invented Combination", form: "tablet", routeClass: "systemic",
      salts: [{ saltId: a }, { saltId: b }], acknowledgeIntraFdc: true,
    }));
    expect((await catalogueCensus(db)).medicines).toBe(1);

    // The acknowledgement is ON THE EVENT: an FDC admitted over a known internal interaction is a
    // fact somebody may want to find later, and the row itself does not record it.
    const evs = await eventsNamed(db, "medicine.added");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload as { medicineId: string; intraFdcAcknowledged: boolean })
      .toMatchObject({ medicineId, intraFdcAcknowledged: true });
  });

  /**
   * C6 (independent review) — DD8's GATE HAS TWO DOORS AND ONLY ONE HAD A LOCK.
   *
   * The test above exercises `addMedicine` only, and passed throughout. `updateMedicine` accepts a
   * composition too, so creating the medicine single-salt and PATCHing the interacting pair in
   * walked straight past the acknowledgement — and the `medicine.corrected` event recorded no
   * acknowledgement, so nothing downstream could tell either.
   */
  it("updateMedicine refuses to build an interacting FDC without the same acknowledgement", async () => {
    const { saltId: a } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "ciprofloxacin" }));
    const { saltId: b } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "theophylline" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: a, saltBId: b, severity: "severe",
      note: "ciprofloxacin raises theophylline levels — toxicity risk", source: "seed-2026-08",
    }));
    // Created single-salt, which is legitimate and un-gated.
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Invented Combination", form: "tablet", routeClass: "systemic", salts: [{ saltId: a }],
    }));

    // PATCHing the pair in is the SAME act as creating it, and meets the same gate.
    await expect(
      withTx(db, (tx) => updateMedicine(tx, PHARMACIST, medicineId, {
        salts: [{ saltId: a }, { saltId: b }],
      })),
    ).rejects.toMatchObject({ code: "intra_fdc_interaction" });

    // The composition did not move. `medicineId` is in hand, so the read NAMES the row under test
    // instead of trusting that the only medicine in the table is that one.
    expect(await compositionOf(medicineId)).toEqual([a]);

    // Acknowledged, it lands — and the correction is evented.
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, medicineId, {
      salts: [{ saltId: a }, { saltId: b }], acknowledgeIntraFdc: true,
    }));
    expect((await compositionOf(medicineId)).sort()).toEqual([a, b].sort());
    expect(await eventsNamed(db, "medicine.corrected")).toHaveLength(1);
  });

  /** M4 — a medicine with no composition is the "known, and contains nothing" row C3 showed is invisible. */
  it("a medicine with no moieties is refused at the domain function, not only by zod", async () => {
    await expect(
      withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "Empty Thing", form: "tablet", routeClass: "systemic", salts: [],
      })),
    ).rejects.toMatchObject({ code: "unknown_salt" });
    expect((await catalogueCensus(db)).medicines).toBe(0);
  });

  it("a single-moiety medicine never consults the pair table at all", async () => {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Crocin 650", form: "tablet", routeClass: "systemic", salts: [{ saltId }],
    }));
    const evs = await eventsNamed(db, "medicine.added");
    expect(evs[0]!.payload as { intraFdcAcknowledged: boolean }).toMatchObject({ intraFdcAcknowledged: false });
  });

  // ──────────────── a correction is not an update, and the stream has to say so ────────────────

  /**
   * THE DISCRIMINATION SPEC §1.1 DEFERS A WHOLE FEATURE ON. Retro-scanning still-active
   * prescriptions issued under an old composition is a named deferral, and the ONLY thing that
   * keeps it buildable is that a composition change is distinguishable in the event stream from a
   * typo fix. Both legs are here so an implementation that emits one name for everything fails.
   */
  it("changing the composition emits `medicine.corrected`; changing an attribute does not", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();

    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { scheduleFlag: "H" }));
    expect(await eventsNamed(db, "medicine.corrected")).toHaveLength(0);
    expect(await eventsNamed(db, "medicine.updated")).toHaveLength(1);
    expect((await eventsNamed(db, "medicine.updated"))[0]!.payload as { changed: string[] })
      .toMatchObject({ changed: ["scheduleFlag"] });

    // The clavulanic acid was wrong: this brand is plain amoxicillin. THAT is a correction.
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { salts: [{ saltId: amox }] }));
    const corrected = await eventsNamed(db, "medicine.corrected");
    expect(corrected).toHaveLength(1);
    const payload = corrected[0]!.payload as { fromSaltIds: string[]; toSaltIds: string[] };
    expect([...payload.fromSaltIds].sort()).toEqual([amox, clav].sort());
    expect(payload.toSaltIds).toEqual([amox]);
    // The composition really moved, not just the event.
    expect(await compositionOf(augmentin)).toEqual([amox]);

    // Re-stating the SAME composition is not a correction — nothing about the medicine changed.
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { salts: [{ saltId: amox }] }));
    expect(await eventsNamed(db, "medicine.corrected")).toHaveLength(1);
  });

  it("updating an unknown row is a typed 404-shaped refusal, per entity", async () => {
    await expect(
      withTx(db, (tx) => updateMedicine(tx, PHARMACIST, "01HNOSUCH000000000000000001", { active: false })),
    ).rejects.toMatchObject({ code: "unknown_medicine" });
    await expect(
      withTx(db, (tx) => updateSalt(tx, PHARMACIST, "01HNOSUCH000000000000000001", { active: false })),
    ).rejects.toMatchObject({ code: "unknown_salt" });
    // Not `unknown_salt`: the salts are fine and the PAIR is missing (CLOSE F5).
    await expect(
      withTx(db, (tx) => updateInteraction(tx, PHARMACIST, "01HNOSUCH000000000000000001", { active: false })),
    ).rejects.toMatchObject({ code: "unknown_interaction" });
  });

  it("a curator can downgrade a pair's severity, and the change is evented", async () => {
    const { saltId: a } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const { saltId: b } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    const { interactionId } = await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: a, saltBId: b, severity: "severe", note: "INR rise on sustained use", source: "manual",
    }));
    await withTx(db, (tx) => updateInteraction(tx, PHARMACIST, interactionId, { severity: "moderate" }));
    // Narrowed to the pairs touching these two moieties, so the row read back is the row written.
    const [pair] = (await pageInteractions(db, { saltIds: [a, b] })).items;
    expect(pair!.id).toBe(interactionId);
    expect(pair!.severity).toBe("moderate");
    const evs = await eventsNamed(db, "interaction.updated");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload as { changed: string[] }).toMatchObject({ changed: ["severity"] });
  });

  it("deactivating hides a row from the active-only reads without deleting it", async () => {
    const { amox, clav, augmentin } = await seedAugmentin();
    await withTx(db, (tx) => updateMedicine(tx, PHARMACIST, augmentin, { active: false }));
    await withTx(db, (tx) => updateSalt(tx, PHARMACIST, amox, { active: false }));

    // Both halves of "hidden, not deleted" in ONE statement of the census: the ACTIVE counts fell
    // and the TOTAL counts did not. A row that had really been deleted moves both, so a census that
    // only counted the active ones could not tell the two apart.
    const census = await catalogueCensus(db);
    expect({
      medicines: census.medicines, activeMedicines: census.activeMedicines,
      salts: census.salts, activeSalts: census.activeSalts,
    }).toEqual({ medicines: 1, activeMedicines: 0, salts: 2, activeSalts: 1 });

    // And the surviving moiety is the clavulanic acid, not merely "one of them": the comment this
    // assertion used to carry beside it is now the assertion.
    expect((await pageSalts(db, { activeOnly: true })).items.map((s) => s.id)).toEqual([clav]);
    // Hidden, yet still nameable by id — which is what "not deleted" means to a dispensing label.
    expect((await medicinesByIds(db, [augmentin])).get(augmentin)!.active).toBe(false);
    expect((await saltsByIds(db, [amox])).get(amox)!.active).toBe(false);
  });
});
