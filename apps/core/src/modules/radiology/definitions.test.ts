import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { studyTypeRow } from "../../../test/helpers/radiology";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { imagingDefinitions } from "../../kernel/db/schema";
import {
  activeDefinition, activeDefinitionRow, draftDefinition, parseDefinitionBody, publishDefinition,
  requestDefinitionPublish, studyTypesBodySchema,
} from "./definitions";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { RadiologyError } from "./errors";
import { STUDY_TYPE_SEEDS, activeStudyTypes, requireStudyType, studyTypeFor } from "./study-types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T4 — Assertion Book row **A5**, plus the schema invariants the body carries.
 *
 * The publish flow is `modules/ot/definitions.ts`'s, transcribed, so this suite is deliberately the
 * OT's shape too: the same four refusals, asserted against the radiology approval type. Where a
 * pattern is copied, copying its tests is how you find out whether the copy is faithful.
 */
describe("imaging definitions (18a T4 / DD13)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let drafter: Actor;
  let ms: Actor;
  let owner: Actor;

  const SVC_A = "01SERVICEAAAAAAAAAAAAAAAAA";
  const SVC_B = "01SERVICEBBBBBBBBBBBBBBBBB";
  const bodyWith = (...types: ReturnType<typeof studyTypeRow>[]) => ({ types });
  const TWO_TYPES = bodyWith(
    studyTypeRow({ code: "USG-ABDO", service_id: SVC_A }),
    studyTypeRow({ code: "XR-CHEST", service_id: SVC_B, modality: "xray", body_part: "chest", ionising: true }),
  );

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedSodPairs(db);
    for (const role of ["owner", "medical_superintendent"]) await ensureRole(db, role);
    ({ actor: drafter } = await mkUser(db, "rad.drafter", ["owner"]));
    ({ actor: ms } = await mkUser(db, "ms.iyer", ["medical_superintendent"]));
    ({ actor: owner } = await mkUser(db, "owner.one", ["owner"]));
    await registerRadiologyApprovalTypes(db, owner);
  });

  const draftAndRequest = async (kind: "study_types" | "pregnancy_policy", body: unknown) =>
    await withTx(db, async (tx) => {
      const d = await draftDefinition(tx, drafter, { kind, body });
      const { approvalId } = await requestDefinitionPublish(tx, drafter, d.definitionId);
      return { ...d, approvalId };
    });

  const PREGNANCY_BODY = {
    min_age_years: 12, max_age_years: 55,
    accepted_evidence: ["declaration", "lmp_date", "hcg_result"],
    hcg_validity_days: 7, declaration_sufficient_for_ionising: false,
  };

  /* ═══════════════════════════ A5 — GOVERNANCE ═══════════════════════════ */

  it("A5: a draft is INERT — `activeDefinition` refuses until it is published", async () => {
    await draftAndRequest("study_types", TWO_TYPES);
    await expect(activeDefinition(db, "study_types")).rejects.toThrow(RadiologyError);
    await expect(activeDefinition(db, "study_types")).rejects.toThrow(/no active study_types definition/);
  });

  it("A5: publishing REFUSES an approval that is not granted", async () => {
    const d = await draftAndRequest("study_types", TWO_TYPES);
    await expect(publishDefinition(db, ms, { definitionId: d.definitionId, approvalId: d.approvalId }))
      .rejects.toThrow(/not granted/);
  });

  /**
   * The SUBJECT is compared, not just the status. A caller holding a granted approval for a
   * DIFFERENT definition must not be able to publish this one — otherwise one approved change is a
   * key to every pending one.
   */
  it("A5: an approval granted for a DIFFERENT definition does not authorise this one", async () => {
    const a = await draftAndRequest("study_types", TWO_TYPES);
    const b = await draftAndRequest("pregnancy_policy", PREGNANCY_BODY);
    await approveRequest(db, ms, { approvalId: b.approvalId, note: "ok" });

    await expect(publishDefinition(db, ms, { definitionId: a.definitionId, approvalId: b.approvalId }))
      .rejects.toThrow(/does not authorise/);
  });

  it("the requester cannot approve their own publish — the engine's SoD, executed", async () => {
    const d = await withTx(db, async (tx) => {
      const drafted = await draftDefinition(tx, ms, { kind: "study_types", body: TWO_TYPES });
      const { approvalId } = await requestDefinitionPublish(tx, ms, drafted.definitionId);
      return { ...drafted, approvalId };
    });
    await expect(approveRequest(db, ms, { approvalId: d.approvalId, note: "self" }))
      .rejects.toThrow(/segregation-of-duties/);
  });

  it("a second publish of the same draft is refused — it is no longer a draft", async () => {
    const d = await draftAndRequest("study_types", TWO_TYPES);
    await approveRequest(db, ms, { approvalId: d.approvalId, note: "ok" });
    await publishDefinition(db, ms, { definitionId: d.definitionId, approvalId: d.approvalId });
    await expect(publishDefinition(db, ms, { definitionId: d.definitionId, approvalId: d.approvalId }))
      .rejects.toThrow(/not a draft/);
  });

  /**
   * ═══ A5's MUTANT: RETURNING THE NEWEST ROW ═══
   *
   * *"Return the newest row → a drafted gate set is live before anyone approved it."* This is the
   * discriminating arrangement: version 2 exists and is a DRAFT, version 1 is `active`, and the
   * reader must return version 1. An implementation ordering by `version desc` passes every other
   * test in this file and fails this one.
   */
  it("A5 mutant: `activeDefinition` returns the PUBLISHED version, not the newest draft", async () => {
    const v1 = await draftAndRequest("study_types", TWO_TYPES);
    await approveRequest(db, ms, { approvalId: v1.approvalId, note: "ok" });
    await publishDefinition(db, ms, { definitionId: v1.definitionId, approvalId: v1.approvalId });

    /** Version 2: a DIFFERENT book, drafted and never approved. */
    const v2 = await draftAndRequest("study_types", bodyWith(
      studyTypeRow({ code: "CT-HEAD", service_id: "01SERVICECCCCCCCCCCCCCCCCC", modality: "ct", body_part: "head", ionising: true }),
    ));
    expect(v2.version).toBe(2);

    const active = await activeDefinition(db, "study_types");
    expect(active.types.map((t) => t.code)).toEqual(["USG-ABDO", "XR-CHEST"]);
    expect((await activeDefinitionRow(db, "study_types"))!.version).toBe(1);
  });

  it("publishing v2 supersedes v1, and exactly one version is active at a time", async () => {
    const v1 = await draftAndRequest("study_types", TWO_TYPES);
    await approveRequest(db, ms, { approvalId: v1.approvalId, note: "ok" });
    await publishDefinition(db, ms, { definitionId: v1.definitionId, approvalId: v1.approvalId });

    const v2 = await draftAndRequest("study_types", bodyWith(
      studyTypeRow({ code: "CT-HEAD", service_id: "01SERVICECCCCCCCCCCCCCCCCC", modality: "ct", body_part: "head", ionising: true }),
    ));
    await approveRequest(db, ms, { approvalId: v2.approvalId, note: "ok" });
    const result = await publishDefinition(db, ms, { definitionId: v2.definitionId, approvalId: v2.approvalId });

    expect(result.supersededVersion).toBe(1);
    const rows = await db.select().from(imagingDefinitions);
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
    expect((await activeDefinition(db, "study_types")).types.map((t) => t.code)).toEqual(["CT-HEAD"]);
  });

  /* ═══════════════════════ THE BODY'S OWN INVARIANTS ═══════════════════════ */

  /**
   * Both duplicates are refused at DRAFT, so an ambiguous book cannot even be stored. The
   * `service_id` one is the statutory half: two study types on one service would make "is this scan
   * PCPNDT-applicable?" depend on which row a reader found first.
   */
  it("a body with two types sharing a CODE is refused `definition_invalid`", async () => {
    const dup = bodyWith(
      studyTypeRow({ code: "USG-ABDO", service_id: SVC_A }),
      studyTypeRow({ code: "USG-ABDO", service_id: SVC_B }),
    );
    await expect(draftAndRequest("study_types", dup)).rejects.toThrow(/share a code/);
  });

  it("a body with two types sharing a SERVICE ID is refused — the statutory ambiguity", async () => {
    const dup = bodyWith(
      studyTypeRow({ code: "USG-ABDO", service_id: SVC_A }),
      studyTypeRow({ code: "USG-PELVIS", service_id: SVC_A, pcpndt_applicable: true }),
    );
    await expect(draftAndRequest("study_types", dup)).rejects.toThrow(/same service_id/);
  });

  it("an unknown modality is refused — the vocabulary is closed", async () => {
    const bad = { types: [{ ...studyTypeRow({ code: "X", service_id: SVC_A }), modality: "pet_ct" }] };
    expect(() => parseDefinitionBody("study_types", bad)).toThrow(/definition is invalid/);
  });

  it("an unknown GATE kind is refused — `gates` is closed against the shipped ten", async () => {
    const bad = { types: [{ ...studyTypeRow({ code: "X", service_id: SVC_A }), gates: ["invented_gate"] }] };
    expect(() => parseDefinitionBody("study_types", bad)).toThrow(/definition is invalid/);
  });

  /**
   * DEFENCE IN DEPTH: a body that reached the table AROUND the API — a data fix, a restored dump —
   * must not become active. `publishDefinition` re-parses the stored body rather than trusting that
   * it was validated when drafted.
   */
  it("a body inserted around the API is refused AT PUBLISH, not silently activated", async () => {
    const definitionId = newId();
    await db.insert(imagingDefinitions).values({
      id: definitionId, kind: "study_types", version: 1, status: "draft", draftedBy: drafter.id,
      body: { types: [{ code: "BROKEN", service_id: SVC_A }] },
    });
    const { approvalId } = await withTx(db, (tx) => requestDefinitionPublish(tx, drafter, definitionId));
    await approveRequest(db, ms, { approvalId, note: "ok" });

    await expect(publishDefinition(db, ms, { definitionId, approvalId }))
      .rejects.toThrow(/definition is invalid/);
  });

  /* ═══════════════════════ THE SEEDS AND THE READERS ═══════════════════════ */

  /**
   * The twenty seeds must themselves satisfy the schema they will be published under. A seed set
   * that could not be published is a runbook step that fails at go-live, in front of the owner.
   */
  it("the TWENTY seeds parse under the published body's own schema", async () => {
    expect(STUDY_TYPE_SEEDS).toHaveLength(20);
    const withIds = STUDY_TYPE_SEEDS.map(({ service_code, ...rest }, i) => ({
      ...rest, service_id: `01SERVICE${String(i).padStart(17, "0")}`,
    }));
    const parsed = studyTypesBodySchema.safeParse({ types: withIds });
    expect(parsed.success).toBe(true);
  });

  it("the seeds' codes and service codes are each unique", async () => {
    expect(new Set(STUDY_TYPE_SEEDS.map((t) => t.code)).size).toBe(20);
    expect(new Set(STUDY_TYPE_SEEDS.map((t) => t.service_code)).size).toBe(20);
  });

  it("exactly THREE seeds are PCPNDT-applicable, and all three are ultrasound", async () => {
    const covered = STUDY_TYPE_SEEDS.filter((t) => t.pcpndt_applicable);
    expect(covered.map((t) => t.code).sort()).toEqual(["USG-OBS-ANOMALY", "USG-OBS-EARLY", "USG-PELVIS"]);
    for (const type of covered) {
      expect([type.code, type.modality, type.chaperone_required]).toEqual([type.code, "usg", true]);
    }
  });

  it("`studyTypeFor` and `requireStudyType` agree, and the second refuses an unknown code", async () => {
    const v1 = await draftAndRequest("study_types", TWO_TYPES);
    await approveRequest(db, ms, { approvalId: v1.approvalId, note: "ok" });
    await publishDefinition(db, ms, { definitionId: v1.definitionId, approvalId: v1.approvalId });

    const body = await activeDefinition(db, "study_types");
    expect(studyTypeFor(body, "USG-ABDO")?.service_id).toBe(SVC_A);
    expect(studyTypeFor(body, "NOPE")).toBeUndefined();

    expect((await requireStudyType(db, "USG-ABDO")).service_id).toBe(SVC_A);
    await expect(requireStudyType(db, "NOPE")).rejects.toThrow(/no study type "NOPE"/);
    expect((await activeStudyTypes(db)).map((t) => t.code)).toEqual(["USG-ABDO", "XR-CHEST"]);
  });
});
