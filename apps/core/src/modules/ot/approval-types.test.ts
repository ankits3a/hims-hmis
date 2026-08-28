import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedSodPairs } from "../../kernel/auth/sod";
import { getApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import {
  DEFINITION_PUBLISH_APPROVAL_TYPE, DEPOSIT_EXCEPTION_APPROVAL_TYPE, OT_APPROVAL_TYPES,
  registerOtApprovalTypes,
} from "./approval-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T2 / DD6 + DD12 — the two approval types, and the property the deploy path depends on.
 *
 * `materials/approval-types.test.ts`'s discipline, transcribed: idempotence is asserted BY
 * EXECUTION in both directions, because only one of the two failures is loud. A second
 * `registerApprovalType` throws `duplicate_type` and aborts the deploy; a second
 * `createDraft` + `activateDefinition` SILENTLY adds a workflow definition VERSION for the same key,
 * growing by one on every deploy for the life of the hospital. The version-count leg is for the
 * second one.
 */
const activator: Actor = { type: "user", id: "test-ot-activator" };

describe("the OT approval types (Plan 15 T2 / DD6, DD12)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); });

  async function definitionVersions(): Promise<{ key: string; versions: number }[]> {
    const rows = (await db.execute(sql`
      select def_key as "key", count(*)::int as "versions" from workflow_definitions
      where def_key like 'approval_ot%' group by def_key order by def_key
    `)).rows as { key: string; versions: number }[];
    return rows;
  }

  /**
   * ═══ THE APPROVER ROLES ARE THE DECISION, AND THEY ARE DIFFERENT ON PURPOSE ═══
   *
   * `ot_definition_publish` → `medical_superintendent`: what the unit may operate on is a clinical
   * governance question. `ot_deposit_exception` → `owner`: waiving a deposit is a money question,
   * and the person who waives it must not be the person under pressure to fill the list. A test that
   * only checked "both have an approver" would pass if somebody set both to the MS, which is the
   * edit that looks like a simplification and is the whole of the control.
   */
  it("names two types, with DIFFERENT approvers and neither allowing act-first", () => {
    expect(OT_APPROVAL_TYPES.map((t) => t.typeKey)).toEqual([
      DEFINITION_PUBLISH_APPROVAL_TYPE, DEPOSIT_EXCEPTION_APPROVAL_TYPE,
    ]);
    expect(OT_APPROVAL_TYPES.map((t) => ({ key: t.typeKey, approver: t.approverRole, actFirst: t.actFirstAllowed }))).toEqual([
      { key: "ot_definition_publish", approver: "medical_superintendent", actFirst: false },
      { key: "ot_deposit_exception", approver: "owner", actFirst: false },
    ]);
    // The deposit exception is the SHORTER SLA of the two, and that ordering is the decision: a list
    // is running and the alternative to a decision is a postponed operation, where nothing at all is
    // waiting on a definition publish.
    const [publish, exception] = OT_APPROVAL_TYPES;
    expect(exception!.closureSlaMinutes).toBeLessThan(publish!.closureSlaMinutes);
    expect({ publish: publish!.closureSlaMinutes, exception: exception!.closureSlaMinutes })
      .toEqual({ publish: 1440, exception: 120 });
  });

  it("registers both types and activates one flow definition version each", async () => {
    await registerOtApprovalTypes(db, activator);
    for (const spec of OT_APPROVAL_TYPES) {
      const found = await withTx(db, (tx: Tx) => getApprovalType(tx, spec.typeKey));
      expect({ key: spec.typeKey, found: found !== undefined }).toEqual({ key: spec.typeKey, found: true });
    }
    expect(await definitionVersions()).toEqual([
      { key: "approval_ot_definition_publish", versions: 1 },
      { key: "approval_ot_deposit_exception", versions: 1 },
    ]);
  });

  it("is IDEMPOTENT — a second run registers nothing and drafts no redundant version", async () => {
    await registerOtApprovalTypes(db, activator);
    // A second run in the re-deploy path. The loud half: this must not throw `duplicate_type`.
    await registerOtApprovalTypes(db, activator);
    // The quiet half, and the one this leg exists for: still ONE version per key. A second draft is
    // not an error — it is a permanent lie about how many times the flow changed.
    expect(await definitionVersions()).toEqual([
      { key: "approval_ot_definition_publish", versions: 1 },
      { key: "approval_ot_deposit_exception", versions: 1 },
    ]);
  });

  /**
   * The drafter is a fixed SYSTEM identity and the activator is the caller's. `assertNotSodPair`
   * compares IDS, never types, so what makes the drafter/activator pair legal is that the two ids
   * differ — and a caller passing the drafter's own id must be refused rather than quietly allowed.
   */
  it("refuses to activate when the caller IS the fixed drafter (the SoD pair, executed)", async () => {
    await expect(registerOtApprovalTypes(db, { type: "user", id: "ot-approval-drafter" }))
      .rejects.toThrow(/segregation-of-duties/);
    /**
     * WHAT THE REFUSAL ACTUALLY LEAVES BEHIND, stated rather than assumed — the honest version of
     * "nothing half-registered".
     *
     * `registerOtApprovalTypes` drafts, THEN activates, THEN registers, and each step is its own
     * transaction (`createDraft` and `activateDefinition` both take `db`). So a refusal at the
     * activation step leaves a DRAFT row and NO approval type. That is the correct outcome and the
     * deploy fails loudly — but a draft is not nothing, and the next run's `getApprovalType` miss
     * makes it draft a SECOND one. Recorded here so the behaviour is a decision rather than a
     * discovery: the only caller is a seed with a fixed, non-drafter activator id, so this path is
     * reachable only by a misconfiguration that should stop the deploy.
     */
    const found = await withTx(db, (tx: Tx) => getApprovalType(tx, DEFINITION_PUBLISH_APPROVAL_TYPE));
    expect(found).toBeNull();
    const rows = (await db.execute(sql`
      select status, count(*)::int as "n" from workflow_definitions
      where def_key like 'approval_ot%' group by status
    `)).rows as { status: string; n: number }[];
    expect(rows).toEqual([{ status: "draft", n: 1 }]);
  });
});
