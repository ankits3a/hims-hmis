import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedSodPairs } from "../../kernel/auth/sod";
import { getApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import { LAB_APPROVAL_TYPES, RELEASE_UNPAID_APPROVAL_TYPE, registerLabApprovalTypes } from "./approval-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17 T2 / DD6 — the one approval type, and the property the deploy path depends on.
 *
 * `ot/approval-types.test.ts`'s discipline, transcribed: idempotence is asserted BY EXECUTION in
 * both directions, because only one of the two failures is loud. A second `registerApprovalType`
 * throws `duplicate_type` and aborts the deploy; a second `createDraft` + `activateDefinition`
 * SILENTLY adds a workflow definition VERSION for the same key, growing by one on every deploy for
 * the life of the hospital. The version-count leg is for the second one.
 *
 * ═══ WHY THIS FILE EXISTS AT T2 AT ALL ═══
 *
 * `requestApproval` throws `unknown_type` for a key no `approval_types` row carries. `patient_merge`
 * went unregistered from Plan 05 until 2026-08-26 — every merge request on the live box threw the
 * whole time — and `tariff_revision` made a tariff undraftable in production. Both were found by a
 * human looking. The interlock's ONLY override runs through this type; unregistered, a held report
 * could never be released at all, and the first person to discover that would be a patient at a
 * counter.
 */
const activator: Actor = { type: "user", id: "test-lab-activator" };

describe("the lab approval type (Plan 17 T2 / DD6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); });

  async function definitionVersions(): Promise<{ key: string; versions: number }[]> {
    const rows = (await db.execute(sql`
      select def_key as "key", count(*)::int as "versions" from workflow_definitions
      where def_key like 'approval_lab%' group by def_key order by def_key
    `)).rows as { key: string; versions: number }[];
    return rows;
  }

  /**
   * ═══ THE APPROVER IS THE MONEY OFFICE, AND THAT IS THE DECISION ═══
   *
   * `billing_manager`, not the pathologist. The interlock exists to collect a self-pay balance; the
   * decision to hand the document over anyway is a decision to carry a receivable. The pathologist
   * is the person standing in front of the patient who is asking, which is exactly why it must not
   * be theirs.
   *
   * `actFirstAllowed: false` is the field worth arguing about, and the argument is that the
   * clinical case for act-first is already answered elsewhere: **the interlock never touches a
   * clinician's read** (T7 A3) and the critical-value call never consults it, so what this releases
   * is a printed or messaged copy for the patient. There is no version of that which cannot wait
   * for a reply — and an act-first release would be indistinguishable from no interlock.
   */
  it("declares exactly one type: `lab_release_unpaid`, approved by billing_manager, no act-first", () => {
    expect(LAB_APPROVAL_TYPES).toHaveLength(1);
    const [spec] = LAB_APPROVAL_TYPES;
    expect([spec!.typeKey, spec!.approverRole, spec!.actFirstAllowed, spec!.urgencyClass, spec!.closureSlaMinutes])
      .toEqual([RELEASE_UNPAID_APPROVAL_TYPE, "billing_manager", false, "urgent", 60]);
  });

  /**
   * THE KEY IS snake_case AND IT HAS TO BE (finding F4). The phase document wrote the type key as
   * `lab.release_unpaid`; the registration drafts a workflow definition named `approval_<typeKey>`,
   * and `definition.ts:28` validates that key against `KEY_RE` with the message *"definition key
   * must be lowercase snake_case"*. A dotted key would throw at the FIRST deploy that ran the seed,
   * with the whole interlock override unregistered behind it.
   */
  it("the type key is snake_case, because the definition key it produces must be", () => {
    expect(RELEASE_UNPAID_APPROVAL_TYPE).toBe("lab_release_unpaid");
    expect(RELEASE_UNPAID_APPROVAL_TYPE).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("registers the type and activates exactly one definition version", async () => {
    await registerLabApprovalTypes(db, activator);
    const registered = await withTx(db, (tx: Tx) => getApprovalType(tx, RELEASE_UNPAID_APPROVAL_TYPE));
    expect(registered?.approverRole).toBe("billing_manager");
    expect(await definitionVersions()).toEqual([{ key: "approval_lab_release_unpaid", versions: 1 }]);
  });

  /**
   * IDEMPOTENT IN BOTH DIRECTIONS, PROVED BY RUNNING IT TWICE. `deploy.sh` runs the seed on every
   * deploy, so "twice" is the normal case rather than an edge one.
   */
  it("a second run registers nothing new and drafts NO second version", async () => {
    await registerLabApprovalTypes(db, activator);
    await registerLabApprovalTypes(db, activator);
    expect(await definitionVersions()).toEqual([{ key: "approval_lab_release_unpaid", versions: 1 }]);
    const registered = await withTx(db, (tx: Tx) => getApprovalType(tx, RELEASE_UNPAID_APPROVAL_TYPE));
    expect(registered?.typeKey).toBe(RELEASE_UNPAID_APPROVAL_TYPE);
  });
});
