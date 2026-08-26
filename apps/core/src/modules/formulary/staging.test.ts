import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { events, formularyStaging } from "../../kernel/db/schema";
import { addSalt, listMedicines } from "./masters";
import { resolveDrugTexts, resolveMedicines } from "./resolve";
import { admitStaging, getStagingRow, rejectStaging, searchStaging } from "./staging";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16a T7 — staging admission.
 *
 * The isolation law is the first test and the most important one: a mined row is a DICTIONARY
 * ENTRY, not a medicine, and no safety check may ever see it. It is asserted by FIXTURE — a real
 * pending row, a real resolution call — rather than by observing that the code contains no query,
 * because "resolve.ts does not read that table" is a claim that rots the first time somebody adds
 * a convenience join.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const MINED_AT = new Date("2026-08-20T00:00:00.000Z");
const AT = new Date("2026-08-26T09:00:00.000Z");

describe("formulary staging (Plan 16a T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function mine(id: string, name: string, payload: Record<string, unknown> = {}): Promise<void> {
    await db.insert(formularyStaging).values({
      id, kind: "medicine", name, payload,
      sourceUrl: `https://example.invalid/${id}`, minedAt: MINED_AT,
    });
  }

  // ─────────────────────────── the isolation law ───────────────────────────

  it("a PENDING row is invisible to every resolution path", async () => {
    await mine("G1", "Augmentin 625", { salts: ["amoxicillin", "clavulanic acid"] });

    expect((await resolveDrugTexts(db, ["Augmentin 625"])).get("Augmentin 625")).toBeNull();
    expect((await resolveMedicines(db, ["G1"])).size).toBe(0);
    expect(await listMedicines(db)).toHaveLength(0);
    // It IS findable by the human who is about to admit it — that is the whole point of the table.
    expect((await searchStaging(db, "augmentin")).map((r) => r.id)).toEqual(["G1"]);
  });

  it("the search is pull-based and generous, and it never answers with a decided row", async () => {
    await mine("G1", "Augmentin 625");
    await mine("G2", "Amoxycillin 500");
    await mine("G3", "Crocin 650");

    // Generous on purpose (a human reads the answer): a partial name finds it.
    expect((await searchStaging(db, "amox")).map((r) => r.id)).toEqual(["G2"]);
    // Normalized on both sides — the same normalizer the safety path uses.
    expect((await searchStaging(db, "AUGMENTIN 625")).map((r) => r.id)).toEqual(["G1"]);
    /**
     * AND THE EDGE THAT SURPRISED THIS SESSION, pinned rather than smoothed over (CLOSE F20).
     * DD2's normalizer STRIPS `-` rather than turning it into a space, so "Augmentin-625" becomes
     * `augmentin625` and does not match the stored `augmentin 625`. That is the specified
     * behaviour and it fails SAFE everywhere it matters: on the resolution path an unmatched text
     * resolves to `null` and falls through to the legacy substring layer, which still protects the
     * line. Here it costs a pharmacist one retry with a space.
     */
    expect(await searchStaging(db, "AUGMENTIN-625")).toEqual([]);
    // An empty query is not "everything": there is no queue view, by design.
    expect(await searchStaging(db, "   ")).toEqual([]);

    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    await withTx(db, (tx) => admitStaging(tx, PHARMACIST, "G3", {
      brandName: "Crocin 650", form: "tablet", routeClass: "systemic", salts: [{ saltId }],
    }, AT));
    expect(await searchStaging(db, "crocin")).toEqual([]);
  });

  // ─────────────────────────── admission ───────────────────────────

  it("admitting creates the medicine with its composition and back-links both ways", async () => {
    await mine("G1", "Augmentin 625", { salts: ["amoxicillin", "clavulanic acid"], schedule: "H" });
    const { saltId: amox } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, {
      name: "amoxicillin", drugClass: "penicillin",
    }));
    const { saltId: clav } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "clavulanic acid" }));

    const { medicineId } = await withTx(db, (tx) => admitStaging(tx, PHARMACIST, "G1", {
      brandName: "Augmentin 625", form: "tablet", routeClass: "systemic", scheduleFlag: "H",
      salts: [{ saltId: amox, strength: "500 mg" }, { saltId: clav, strength: "125 mg" }],
    }, AT));

    const [medicine] = await listMedicines(db);
    expect(medicine!.id).toBe(medicineId);
    expect(medicine!.salts.map((s) => s.saltId).sort()).toEqual([amox, clav].sort());
    expect(medicine!.stagingId).toBe("G1");

    const row = await getStagingRow(db, "G1");
    expect({ status: row!.status, medicineId: row!.medicineId, reviewedBy: row!.reviewedBy })
      .toEqual({ status: "approved", medicineId, reviewedBy: PHARMACIST.id });

    // It resolves NOW, and only now.
    expect((await resolveDrugTexts(db, ["Augmentin 625"])).get("Augmentin 625")?.medicineId).toBe(medicineId);

    const evs = await db.select().from(events).where(eq(events.name, "staging.approved"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({
      stagingId: "G1", medicineId, name: "Augmentin 625", sourceUrl: "https://example.invalid/G1",
    });
  });

  /**
   * SEED IS NEVER AUTHORITY, made executable. The mined payload claims one composition; the
   * pharmacist admits another. What lands in the formulary is the HUMAN'S answer — there is no code
   * path that copies `payload` into a table.
   */
  it("what lands is what the pharmacist confirmed, not what the crawl claimed", async () => {
    await mine("G1", "Invented Brand", { salts: ["something the crawl got wrong"], schedule: "X" });
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));

    await withTx(db, (tx) => admitStaging(tx, PHARMACIST, "G1", {
      brandName: "Invented Brand", form: "syrup", routeClass: "systemic", salts: [{ saltId }],
    }, AT));

    const [medicine] = await listMedicines(db);
    expect(medicine!.salts.map((s) => s.saltId)).toEqual([saltId]);
    expect(medicine!.form).toBe("syrup");
    expect(medicine!.scheduleFlag).toBeNull(); // the payload said "X"; nobody confirmed it
    // The payload is KEPT, unchanged — it is the record of what the crawl said.
    const row = await getStagingRow(db, "G1");
    expect(row!.payload).toEqual({ salts: ["something the crawl got wrong"], schedule: "X" });
  });

  it("a row can only be decided once, whichever way it was decided", async () => {
    await mine("G1", "Crocin 650");
    await mine("G2", "Dolo 650");
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    const admit = { brandName: "Crocin 650", form: "tablet", routeClass: "systemic" as const, salts: [{ saltId }] };

    await withTx(db, (tx) => admitStaging(tx, PHARMACIST, "G1", admit, AT));
    await expect(
      withTx(db, (tx) => admitStaging(tx, PHARMACIST, "G1", { ...admit, brandName: "Crocin 650 again" }, AT)),
    ).rejects.toMatchObject({ code: "staging_not_pending" });

    await withTx(db, (tx) => rejectStaging(tx, PHARMACIST, "G2", "not stocked here", AT));
    await expect(
      withTx(db, (tx) => admitStaging(tx, PHARMACIST, "G2", { ...admit, brandName: "Dolo 650" }, AT)),
    ).rejects.toMatchObject({ code: "staging_not_pending" });

    expect(await listMedicines(db)).toHaveLength(1);
  });

  it("a rejection keeps the payload and says who refused it", async () => {
    await mine("G1", "Something Withdrawn", { note: "kept for the record" });
    await withTx(db, (tx) => rejectStaging(tx, PHARMACIST, "G1", "withdrawn from the Indian market", AT));

    const row = await getStagingRow(db, "G1");
    expect({ status: row!.status, reviewedBy: row!.reviewedBy, medicineId: row!.medicineId })
      .toEqual({ status: "rejected", reviewedBy: PHARMACIST.id, medicineId: null });
    expect(row!.payload).toEqual({ note: "kept for the record" });

    const evs = await db.select().from(events).where(eq(events.name, "staging.rejected"));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ stagingId: "G1", reason: "withdrawn from the Indian market" });
  });

  it("an unknown id is refused with the same code rather than a crash", async () => {
    await expect(
      withTx(db, (tx) => rejectStaging(tx, PHARMACIST, "01HNOSUCH000000000000000001", "n/a", AT)),
    ).rejects.toMatchObject({ code: "staging_not_pending" });
    expect(await getStagingRow(db, "01HNOSUCH000000000000000001")).toBeNull();
  });
});
