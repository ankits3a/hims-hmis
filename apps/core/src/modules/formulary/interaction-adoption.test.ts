import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { INTERACTION_RULES_2026_09_17 } from "../../../scripts/data/interaction-rules-2026-09-17";
import { withTx } from "../../kernel/db/client";
import { formularyInteractions, formularySalts, formularySubstances } from "../../kernel/db/schema";
import { adoptInteractions } from "./interaction-adoption";
import { addInteraction, addSalt } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { InteractionRule } from "./interaction-adoption";

/**
 * ═══ FORMULARY P21 — INTERACTION PAIRS ADOPTED FROM A REFERENCE ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p21-interaction-adoption.md`.
 */
const CURATOR: Actor = { type: "user", id: "01HCURATOR0000000000000001" };
const RESOLUTION = "P&T resolution 2026-09-17/2";

describe("adopting interaction pairs by resolution (P21)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const salt = (name: string) => withTx(db, (tx) => addSalt(tx, CURATOR, { name })).then((r) => r.saltId);
  const adopt = (rules: readonly InteractionRule[], actor: Actor = CURATOR) =>
    withTx(db, (tx) => adoptInteractions(tx, actor, RESOLUTION, rules));
  const rule = (a: string, b: string, over: Partial<InteractionRule> = {}): InteractionRule => ({
    rule: "ddi_rules#4", a, b, severity: "severe", note: "Bleeding risk — avoid.", ...over,
  });

  it("writes a pair between two moieties under the resolution, leaves a recorded pair alone, and waits for a name that is not a moiety yet", async () => {
    const warfarin = await salt("warfarin");
    const ibuprofen = await salt("ibuprofen");
    const naproxen = await salt("Naproxen");
    // A release entry nobody has decided is not a moiety, so no pair may point at it yet.
    const apixaban = newId();
    await db.insert(formularySalts).values({ id: apixaban, name: "Apixaban", sourceRef: "SCT-APX", createdBy: CURATOR.id, updatedBy: CURATOR.id });
    await db.insert(formularySubstances).values({ id: newId(), sctid: "SCT-APX", name: "Apixaban", mappingStatus: "pending", source: "nrces-2026-09", createdBy: CURATOR.id, updatedBy: CURATOR.id });
    // A curator's own pair, downgraded: a resolution never restores it.
    await withTx(db, (tx) => addInteraction(tx, CURATOR, { saltAId: warfarin, saltBId: ibuprofen, severity: "moderate", note: "Curator's note.", source: "curator" }));

    const report = await adopt([
      rule("ibuprofen", "warfarin"),
      rule("naproxen", "warfarin", { routeScope: "systemic_only" }),
      rule("naproxen", "apixaban"),
      rule("ketorolac", "apixaban"),
      rule("paracetamol", "warfarin", { rule: "ddi_rules#1", severity: "moderate", note: "INR may rise." }),
    ]);
    expect(report).toEqual({
      resolution: RESOLUTION, created: { severe: 1, moderate: 0 }, alreadyRecorded: 1, skipped: 3,
      missing: [{ name: "apixaban", pairs: 2 }, { name: "ketorolac", pairs: 1 }, { name: "paracetamol", pairs: 1 }],
    });
    const rows = await db.select().from(formularyInteractions);
    expect(rows.map((r) => [r.severity, r.note, r.source, r.routeScope]).sort()).toEqual([
      ["moderate", "Curator's note.", "curator", null],
      ["severe", "Bleeding risk — avoid.", `resolution:${RESOLUTION} (ddi_rules#4)`, "systemic_only"],
    ]);
    const [adopted] = rows.filter((r) => r.source !== "curator");
    expect([adopted!.saltAId, adopted!.saltBId].sort()).toEqual([naproxen, warfarin].sort());
    expect(adopted!.createdBy).toBe(CURATOR.id);

    // Decided later: the same adoption, run again, adds only what now has both moieties.
    await db.update(formularySubstances).set({ mappingStatus: "mapped", saltId: apixaban, mappedBy: CURATOR.id, mappedAt: new Date() }).where(eq(formularySubstances.sctid, "SCT-APX"));
    const again = await adopt([rule("ibuprofen", "warfarin"), rule("naproxen", "warfarin"), rule("naproxen", "apixaban"), rule("ketorolac", "apixaban")]);
    expect(again).toMatchObject({ created: { severe: 1, moderate: 0 }, alreadyRecorded: 2, skipped: 1, missing: [{ name: "ketorolac", pairs: 1 }] });
  });

  it("is a person's act, and refuses a malformed list before writing anything", async () => {
    await salt("warfarin");
    await salt("ibuprofen");
    await expect(adopt([rule("ibuprofen", "warfarin")], { type: "system", id: "seed" })).rejects.toMatchObject({ code: "attester_not_user" });
    await expect(adopt([rule("warfarin", "Warfarin")])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([rule("ibuprofen", "warfarin"), rule("Warfarin", "ibuprofen")])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(adopt([rule("ibuprofen", "warfarin", { note: " " })])).rejects.toMatchObject({ code: "invalid_adoption" });
    await expect(withTx(db, (tx) => adoptInteractions(tx, CURATOR, " ", [rule("ibuprofen", "warfarin")]))).rejects.toMatchObject({ code: "invalid_adoption" });
    expect(await db.select().from(formularyInteractions)).toEqual([]);
  });

  it("the 2026-09-17 list is well formed: 157 distinct pairs, every one with a note and a source rule", async () => {
    const rules = INTERACTION_RULES_2026_09_17;
    expect(rules).toHaveLength(157);
    expect(rules.filter((r) => r.severity === "severe")).toHaveLength(122);
    // Azithromycin is not a meaningful CYP3A4 inhibitor: the source named it, the list does not.
    expect(rules.some((r) => r.a === "azithromycin" || r.b === "azithromycin")).toBe(false);
    expect(rules.find((r) => r.a === "paracetamol" && r.b === "isoniazid")?.severity).toBe("moderate");
    // Nothing is in this formulary yet, so everything waits; the list itself validates.
    const report = await adopt(rules);
    expect(report.created).toEqual({ severe: 0, moderate: 0 });
    expect(report.skipped).toBe(157);
    expect(await db.select().from(formularyInteractions)).toEqual([]);
  });
});
