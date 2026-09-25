import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedSodPairs } from "../../kernel/auth/sod";
import { getApprovalType } from "../../kernel/approvals/types";
import { withTx } from "../../kernel/db/client";
import {
  MATERIALS_APPROVAL_TYPES, NEAR_EXPIRY_APPROVAL_TYPE, PAYMENT_RUN_APPROVAL_TYPE, PO_APPROVAL_TYPE, PO_OWNER_APPROVAL_TYPE,
  STOCK_ADJUSTMENT_APPROVAL_TYPE, VENDOR_BANK_CHANGE_APPROVAL_TYPE,
  registerMaterialsApprovalTypes,
} from "./approval-types";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 14 T2 / DD10 — the two approval types, and the property the deploy path depends on.
 *
 * ═══ IDEMPOTENCE IS ASSERTED BY EXECUTION, IN BOTH DIRECTIONS ═══
 *
 * `deploy.sh` runs `seed-materials.js` on EVERY deploy, so "a second call registers nothing" is not
 * a nicety — it is the property that lets this sit in the re-deploy path for ever. Two things could
 * go wrong and only one of them is loud:
 *
 *   · A second `registerApprovalType` would throw `duplicate_type`, aborting the deploy under
 *     `set -euo pipefail`. LOUD, and a test that only asserted "no throw" would catch it.
 *   · A second `createDraft` + `activateDefinition` would SILENTLY add a workflow definition
 *     VERSION for the same key. Not an error — just a permanent lie about how many times the flow
 *     changed, growing by one on every deploy for the life of the hospital. **That is the one the
 *     version-count leg below exists for**, and it is why this file counts rows rather than
 *     trusting the absence of an exception.
 */
const activator: Actor = { type: "user", id: "test-materials-activator" };

describe("the materials approval types (Plan 14 T2 / DD10)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function definitionVersions(): Promise<{ key: string; versions: number }[]> {
    const rows = (await db.execute(sql`
      select def_key as "key", count(*)::int as "versions" from workflow_definitions
      where def_key like 'approval_materials%' group by def_key order by def_key
    `)).rows as { key: string; versions: number }[];
    return rows;
  }

  // ────────────────────────────── the specs themselves ──────────────────────────────

  /**
   * The approver roles are the DECISION in this file and the plan's, so they are pinned by name
   * rather than left to the table. **O-6 RULED 2026-08-27: the bank change is the OWNER's, always.**
   * A diff that moved it to `materials_head` would put the person who talks to the vendor daily in
   * charge of where the vendor's money goes, and it would compile.
   */
  it("declares exactly six types, with DD10's approver roles and SLAs, 14c's write-off to the MS, P2's two PO tiers and P3's payment run", () => {
    expect(MATERIALS_APPROVAL_TYPES.map((s) => s.typeKey)).toEqual([
      NEAR_EXPIRY_APPROVAL_TYPE, STOCK_ADJUSTMENT_APPROVAL_TYPE, VENDOR_BANK_CHANGE_APPROVAL_TYPE,
      PO_APPROVAL_TYPE, PO_OWNER_APPROVAL_TYPE, PAYMENT_RUN_APPROVAL_TYPE,
    ]);
    // 14c: the write-off is the medical superintendent's, never the materials head who asks for it.
    // Parity P2: a purchase order up to the configured limit is the head's, above it the owner's.
    // Parity P3: the payment run is the owner's to authorise — money leaving the hospital.
    expect(MATERIALS_APPROVAL_TYPES.map((s) => s.approverRole)).toEqual(["materials_head", "medical_superintendent", "owner", "materials_head", "owner", "owner"]);
    expect(MATERIALS_APPROVAL_TYPES.map((s) => s.closureSlaMinutes)).toEqual([240, 1440, 1440, 1440, 1440, 1440]);
    // Neither is act-first: accepting short-dated stock and moving where money goes are both
    // reversible only on paper. See the file header in `approval-types.ts`.
    expect(MATERIALS_APPROVAL_TYPES.every((s) => s.actFirstAllowed === false)).toBe(true);
    expect(MATERIALS_APPROVAL_TYPES.every((s) => s.urgencyClass === "routine")).toBe(true);
  });

  // ────────────────────────────── registration, then idempotence ──────────────────────────────

  it("registers every type and activates one definition version each", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, activator);

    const near = await withTx(db, (tx: Tx) => getApprovalType(tx, NEAR_EXPIRY_APPROVAL_TYPE));
    const bank = await withTx(db, (tx: Tx) => getApprovalType(tx, VENDOR_BANK_CHANGE_APPROVAL_TYPE));
    expect(near?.approverRole).toBe("materials_head");
    expect(bank?.approverRole).toBe("owner");
    // Parity P2 — the purchase order's two tiers.
    expect((await withTx(db, (tx: Tx) => getApprovalType(tx, PO_APPROVAL_TYPE)))?.approverRole).toBe("materials_head");
    expect((await withTx(db, (tx: Tx) => getApprovalType(tx, PO_OWNER_APPROVAL_TYPE)))?.approverRole).toBe("owner");
    expect((await withTx(db, (tx: Tx) => getApprovalType(tx, PAYMENT_RUN_APPROVAL_TYPE)))?.approverRole).toBe("owner");

    expect(await definitionVersions()).toEqual([
      { key: `approval_${NEAR_EXPIRY_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${PAYMENT_RUN_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${PO_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${PO_OWNER_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${STOCK_ADJUSTMENT_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${VENDOR_BANK_CHANGE_APPROVAL_TYPE}`, versions: 1 },
    ]);
  });

  it("a SECOND call registers nothing and drafts NO new definition version", async () => {
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, activator);
    const after1 = await definitionVersions();

    // The deploy path's actual shape: the same script, again, against a database that has it.
    await registerMaterialsApprovalTypes(db, activator);
    await registerMaterialsApprovalTypes(db, activator);

    // No throw is HALF the property; the version count is the other half — see the file header.
    expect(await definitionVersions()).toEqual(after1);
    expect(await definitionVersions()).toEqual([
      { key: `approval_${NEAR_EXPIRY_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${PAYMENT_RUN_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${PO_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${PO_OWNER_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${STOCK_ADJUSTMENT_APPROVAL_TYPE}`, versions: 1 },
      { key: `approval_${VENDOR_BANK_CHANGE_APPROVAL_TYPE}`, versions: 1 },
    ]);
    const rows = (await db.execute(sql`
      select count(*)::int as "n" from approval_types where type_key like 'materials_%'
    `)).rows as { n: number }[];
    expect(rows[0]?.n).toBe(6); // 14c second slice: + materials_stock_adjustment; parity P2: + the two PO tiers; P3: + the payment run
  });
});
