import { setupTestDb, truncateAll } from "./helpers/db";
import { withTx } from "../src/kernel/db/client";
import { getActiveDefinition, listDefinitions } from "../src/kernel/workflow/definitions";
import { getApprovalType } from "../src/kernel/approvals/types";
import { LAB_DEF_KEYS, RELEASE_UNPAID_APPROVAL_TYPE } from "../src/modules/lab";
import { ensureLabStandUp } from "../scripts/seed-lab";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PHASE 11i T1 — the lab's deploy seed.
 *
 * The defect this closes is not a bug in the lab: it is a MODULE THAT IS DEPLOYED AND CANNOT BE
 * USED. `activateLabDefinitions` and `registerLabApprovalTypes` shipped in 17a and, until this
 * task, `test/helpers/lab.ts` was their only caller — so on the production box `startInstance`
 * throws `no_active_definition` for every order and `requestApproval` throws `unknown_type` for
 * `lab_release_unpaid`.
 *
 * The idempotence half is the one that would go unnoticed. A second run does not error; it mints a
 * second `workflow_definitions` VERSION — not a failure, just a lie about how many times the flow
 * changed. So the assertion reads the VERSION COUNT, never the exit code.
 */
const actor: Actor = { type: "user", id: "test-seed-lab" };

describe("seed:lab — the definitions and the approval type a deploy must establish (11i T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("activates both definitions and registers the approval type on a database that has neither", async () => {
    const first = await ensureLabStandUp(db, actor);

    expect(first.definitions.activated.sort()).toEqual([...LAB_DEF_KEYS].sort());
    expect(first.definitions.alreadyActive).toEqual([]);
    expect(first.approvalTypes).toEqual({ registered: [RELEASE_UNPAID_APPROVAL_TYPE], alreadyRegistered: [] });

    for (const key of LAB_DEF_KEYS) {
      const active = await withTx(db, (tx) => getActiveDefinition(tx, key));
      // Class C is why a DEPLOY may establish this at all (D2/D-15): zero required approvals.
      expect(active).toMatchObject({ status: "active", changeClass: "C" });
    }
    expect(await withTx(db, (tx) => getApprovalType(tx, RELEASE_UNPAID_APPROVAL_TYPE))).not.toBeNull();
  });

  it("a second run activates nothing, registers nothing and mints NO second version", async () => {
    await ensureLabStandUp(db, actor);
    const second = await ensureLabStandUp(db, actor);

    expect(second.definitions.activated).toEqual([]);
    expect(second.definitions.alreadyActive.sort()).toEqual([...LAB_DEF_KEYS].sort());
    expect(second.approvalTypes).toEqual({ registered: [], alreadyRegistered: [RELEASE_UNPAID_APPROVAL_TYPE] });

    // THE MUTANT THIS ROW EXISTS FOR: an exit code of 0 says nothing here. Count the versions.
    for (const key of LAB_DEF_KEYS) expect(await listDefinitions(db, key)).toHaveLength(1);
    expect(await listDefinitions(db, `approval_${RELEASE_UNPAID_APPROVAL_TYPE}`)).toHaveLength(1);
  });

  it("REFUSES a `system` activator — the seed adopts the guard, it does not widen it", async () => {
    const system: Actor = { type: "system", id: "seed-lab" };
    await expect(ensureLabStandUp(db, system)).rejects.toThrow();
    // and it left nothing half-built
    for (const key of LAB_DEF_KEYS) {
      expect(await withTx(db, (tx) => getActiveDefinition(tx, key))).toBeNull();
    }
  });
});
