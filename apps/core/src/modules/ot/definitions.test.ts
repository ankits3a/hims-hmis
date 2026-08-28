import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { CRITERIA_BODY, DEPOSIT_POLICY_BODY, PACU_BODY, publishOtDefinition, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import {
  PROCEDURE_CLASS_VALUES, activeDefinition, activeDefinitionRow, criteriaBodySchema, criteriaFor,
  draftDefinition, pacuThresholdsBodySchema, parseDefinitionBody, publishDefinition,
  requestDefinitionPublish,
} from "./definitions";
import { OtError } from "./errors";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T3 / DD6 — governed definition data: the publish flow, and the enum that keeps 15b's
 * territory out of this phase's whitelist.
 */
describe("OT definitions (Plan 15 T3 / DD6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); f = await seedOtBase(db); });

  // ═══════════════════════════════ A5b ═══════════════════════════════

  /**
   * ═══ A5b — THE WHITELIST CANNOT BE WIDENED INTO 15b's TERRITORY BY DATA (F12 / DD18) ═══
   *
   * DD18 rules that `mtp` and the in-unit USG classes are **absent, not stubbed**. This is what
   * "absent" means mechanically: `procedureClass` is a zod ENUM, so a criteria draft naming `mtp`
   * fails validation and cannot be stored — not by an MS in a hurry, not by a seed, not by a
   * hand-written row. The mutant is an enum widened to `z.string()`, which is the shape an author
   * reaches for the first time a department head asks for a procedure the list does not carry.
   */
  it("A5b — a criteria draft naming `mtp` is REFUSED `definition_invalid`", async () => {
    const body = {
      entries: [{ ...CRITERIA_BODY.entries[0]!, procedureClass: "mtp" }],
    };
    await expect(withTx(db, (tx) => draftDefinition(tx, f.ms, { kind: "criteria", body })))
      .rejects.toThrow(OtError);
    await expect(withTx(db, (tx) => draftDefinition(tx, f.ms, { kind: "criteria", body })))
      .rejects.toThrow(/definition_invalid|invalid/);
    // Every USG class too — the second half of what 15b owns.
    for (const usg of ["usg_pelvic", "usg_obstetric", "usg_level2"]) {
      const draft = { entries: [{ ...CRITERIA_BODY.entries[0]!, procedureClass: usg }] };
      await expect(withTx(db, (tx) => draftDefinition(tx, f.ms, { kind: "criteria", body: draft })))
        .rejects.toThrow(OtError);
    }
    // …and the ENUM itself carries neither, which is the property the refusal rests on.
    expect(PROCEDURE_CLASS_VALUES as readonly string[]).not.toContain("mtp");
    expect((PROCEDURE_CLASS_VALUES as readonly string[]).filter((c) => c.startsWith("usg"))).toEqual([]);
    // The control: a LEGAL class in the same shape drafts fine, so the refusal is about the value.
    await withTx(db, (tx) => draftDefinition(tx, f.ms, {
      kind: "criteria", body: { entries: [{ ...CRITERIA_BODY.entries[0]!, procedureClass: "gynae_colposcopy" }] },
    }));
  });

  // ═══════════════════════════════ A2 ═══════════════════════════════

  /**
   * ═══ A2 — A DRAFT IS NOT THE WHITELIST ═══
   *
   * `activeDefinition` reads `status = 'active'`. The mutant reads `max(version)` — which LOOKS
   * like "the current one" and is the natural implementation — and would let a coordinator book a
   * procedure on the strength of a draft nobody has approved.
   *
   * The discriminating fixture is **an active v1 WITHOUT a class and a draft v2 WITH it**. One
   * version does not discriminate, which is exactly what makes this row worth a mutant.
   */
  it("A2 — `activeDefinition` returns the ACTIVE version, never the newest", async () => {
    const active = await activeDefinition(db, "criteria");
    expect(criteriaFor(active, "gynae_colposcopy")).toBeUndefined();

    // A DRAFT v2 that adds the class. Nothing is approved and nothing is published.
    await withTx(db, (tx) => draftDefinition(tx, f.ms, {
      kind: "criteria",
      body: { entries: [...CRITERIA_BODY.entries, {
        ...CRITERIA_BODY.entries[0]!, procedureClass: "gynae_colposcopy",
      }] },
    }));

    const stillActive = await activeDefinition(db, "criteria");
    expect(criteriaFor(stillActive, "gynae_colposcopy")).toBeUndefined();
    expect(stillActive.entries).toHaveLength(CRITERIA_BODY.entries.length);
    // The row the reader returned really is v1 — a mutant reading `max(version)` would return v2.
    const row = await activeDefinitionRow(db, "criteria");
    expect({ version: row!.version, status: row!.status }).toEqual({ version: 1, status: "active" });
  });

  it("publishing v2 supersedes v1, and the reader moves in the same breath", async () => {
    const widened = {
      entries: [...CRITERIA_BODY.entries, { ...CRITERIA_BODY.entries[0]!, procedureClass: "gynae_colposcopy" }],
    };
    await publishOtDefinition(db, { kind: "criteria", body: widened, drafter: f.drafter, ms: f.ms });
    const active = await activeDefinition(db, "criteria");
    expect(criteriaFor(active, "gynae_colposcopy")).toBeDefined();
    const row = await activeDefinitionRow(db, "criteria");
    expect({ version: row!.version, status: row!.status }).toEqual({ version: 2, status: "active" });
  });

  // ═══════════════════════ the publish flow's own refusals ═══════════════════════

  /**
   * DD6 — the engine's `requester_approver` SoD is what forces two humans, and this phase adds
   * nothing to it. The leg is here rather than assumed because DD6's whole honesty argument rests
   * on it: with ONE user, nothing in this module can be published.
   */
  it("the requester cannot approve their own publish — the engine's SoD, executed", async () => {
    const drafted = await withTx(db, async (tx) => {
      const d = await draftDefinition(tx, f.ms, { kind: "criteria", body: CRITERIA_BODY });
      const { approvalId } = await requestDefinitionPublish(tx, f.ms, d.definitionId);
      return { ...d, approvalId };
    });
    await expect(approveRequest(db, f.ms, { approvalId: drafted.approvalId, note: "self" }))
      .rejects.toThrow(/segregation-of-duties/);
  });

  it("publishing REFUSES an approval that is not granted, and one granted for a DIFFERENT definition", async () => {
    const a = await withTx(db, async (tx) => {
      const d = await draftDefinition(tx, f.drafter, { kind: "criteria", body: CRITERIA_BODY });
      const { approvalId } = await requestDefinitionPublish(tx, f.drafter, d.definitionId);
      return { ...d, approvalId };
    });
    // Not yet granted.
    await expect(publishDefinition(db, f.ms, { definitionId: a.definitionId, approvalId: a.approvalId }))
      .rejects.toThrow(/not granted/);

    const b = await withTx(db, async (tx) => {
      const d = await draftDefinition(tx, f.drafter, { kind: "privileges", body: { surgeons: [{ surgeonId: "s1", procedureClasses: [] }] } });
      const { approvalId } = await requestDefinitionPublish(tx, f.drafter, d.definitionId);
      return { ...d, approvalId };
    });
    await approveRequest(db, f.ms, { approvalId: b.approvalId, note: "ok" });
    // B's granted approval must not publish A — the subject is compared, not just the status.
    await expect(publishDefinition(db, f.ms, { definitionId: a.definitionId, approvalId: b.approvalId }))
      .rejects.toThrow(/does not authorise/);
  });

  it("a second publish of the same draft is refused — it is no longer a draft", async () => {
    const d = await withTx(db, async (tx) => {
      const drafted = await draftDefinition(tx, f.drafter, { kind: "deposit_policy", body: DEPOSIT_POLICY_BODY });
      const { approvalId } = await requestDefinitionPublish(tx, f.drafter, drafted.definitionId);
      return { ...drafted, approvalId };
    });
    await approveRequest(db, f.ms, { approvalId: d.approvalId, note: "ok" });
    await publishDefinition(db, f.ms, { definitionId: d.definitionId, approvalId: d.approvalId });
    await expect(publishDefinition(db, f.ms, { definitionId: d.definitionId, approvalId: d.approvalId }))
      .rejects.toThrow(/not a draft/);
  });

  // ═══════════════════ the schemas' own coherence rules ═══════════════════

  /**
   * A criteria row that says `lateral: true` and omits `site_marking` is a whitelist that permits
   * wrong-side surgery, and it would pass any schema that validated fields independently. All five
   * coherences are refused, in both directions where both directions are wrong.
   */
  it("REFUSES a criteria entry whose gates disagree with its own flags", async () => {
    const base = CRITERIA_BODY.entries[1]!; // the lateral, trauma, NPO one
    const cases: [string, Record<string, unknown>][] = [
      ["lateral without site_marking", { requiredGates: base.requiredGates.filter((g) => g !== "site_marking") }],
      ["trauma without mlc", { requiredGates: base.requiredGates.filter((g) => g !== "mlc") }],
      ["npoRequired without the npo gate", { requiredGates: base.requiredGates.filter((g) => g !== "npo") }],
      ["escortRequired without the escort gate", { requiredGates: base.requiredGates.filter((g) => g !== "escort") }],
      ["ageMin above ageMax", { ageMin: 80, ageMax: 5 }],
    ];
    for (const [label, patch] of cases) {
      const body = { entries: [{ ...base, ...patch }] };
      expect({ label, refused: !criteriaBodySchema.safeParse(body).success }).toEqual({ label, refused: true });
    }

    /**
     * A gate marked WAIVABLE that the class does not REQUIRE. The radius class above requires all
     * nine kinds, so it cannot express this case at all — the fixture has to be the D&C, which
     * requires neither `mlc` nor `site_marking`. Recorded because it is §2.102's rule in miniature:
     * the obvious fixture (the richest entry) is the one that cannot discriminate.
     */
    const dnc = CRITERIA_BODY.entries[0]!;
    expect(dnc.requiredGates).not.toContain("mlc");
    expect(criteriaBodySchema.safeParse({
      entries: [{ ...dnc, waivableGates: ["mlc"] }],
    }).success).toBe(false);
    // The OTHER direction of the site-marking rule: a NON-lateral class that requires site_marking
    // would create a gate nothing could ever satisfy — A4's harm, made unreachable at the schema.
    const nonLateral = CRITERIA_BODY.entries[0]!;
    expect(criteriaBodySchema.safeParse({
      entries: [{ ...nonLateral, requiredGates: [...nonLateral.requiredGates, "site_marking"] }],
    }).success).toBe(false);
    // And the shipped fixture passes — the schema is real, not a blanket refusal.
    expect(criteriaBodySchema.safeParse(CRITERIA_BODY).success).toBe(true);
  });

  /**
   * A PACU threshold above the maximum achievable score is a patient who can never be discharged —
   * a configuration that turns the two-bay unit into a zero-bay one, silently, at 6 p.m.
   */
  it("REFUSES a PACU threshold no patient could ever reach", () => {
    const scale = PACU_BODY.scales[0]!;
    const impossible = { scales: [{ ...scale, threshold: 99 }] };
    expect(pacuThresholdsBodySchema.safeParse(impossible).success).toBe(false);
    // Exactly the maximum IS reachable and must be allowed: 5 items x 2 = 10.
    expect(pacuThresholdsBodySchema.safeParse({ scales: [{ ...scale, threshold: 10 }] }).success).toBe(true);
    expect(pacuThresholdsBodySchema.safeParse(PACU_BODY).success).toBe(true);
  });

  it("REFUSES two entries for one procedure class, and two scales for one technique", () => {
    expect(criteriaBodySchema.safeParse({
      entries: [CRITERIA_BODY.entries[0]!, CRITERIA_BODY.entries[0]!],
    }).success).toBe(false);
    expect(pacuThresholdsBodySchema.safeParse({
      scales: [PACU_BODY.scales[0]!, PACU_BODY.scales[0]!],
    }).success).toBe(false);
  });

  it("`parseDefinitionBody` names every problem at once, so an author fixes a body in one pass", () => {
    try {
      parseDefinitionBody("criteria", { entries: [{ ...CRITERIA_BODY.entries[1]!, ageMin: 90, requiredGates: ["npo"] }] });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OtError);
      const otError = error as OtError;
      expect(otError.code).toBe("definition_invalid");
      // More than one issue: the lateral/site_marking, trauma/mlc, escort and age problems together.
      expect((otError.detail as { issues: number }).issues).toBeGreaterThan(1);
    }
  });

  it("`activeDefinition` throws `definition_not_active` for a kind nothing has published", async () => {
    await truncateAll(db);
    await expect(activeDefinition(db, "criteria")).rejects.toThrow(/no ACTIVE criteria definition/);
  });
});
