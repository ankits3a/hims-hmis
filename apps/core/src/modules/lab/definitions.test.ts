import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { getActiveDefinition, listDefinitions } from "../../kernel/workflow/definitions";
import { activateLabDefinitions, LAB_DEF_KEYS } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T4 — the two definitions are DRAFTED AND ACTIVATED, and a second call is a no-op.
 *
 * The idempotence half is the one that would go unnoticed: a second call does not error, it mints a
 * second `workflow_definitions` VERSION — not a failure, just a lie about how many times the flow
 * changed. `approval-types.test.ts` proves the same claim about the same mechanism.
 */
describe("activateLabDefinitions (17a T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); await ensureRole(db, "owner"); });

  it("activates both definitions, and Class C needs no approval", async () => {
    const { actor } = await mkUser(db, "lab.def.activator", []);
    const report = await activateLabDefinitions(db, actor);
    expect(report.activated.sort()).toEqual([...LAB_DEF_KEYS].sort());
    expect(report.alreadyActive).toEqual([]);
    for (const key of LAB_DEF_KEYS) {
      const active = await withTx(db, (tx) => getActiveDefinition(tx, key));
      expect(active?.status).toBe("active");
      expect(active?.changeClass).toBe("C");
    }
  });

  it("a second call activates nothing and mints NO second version", async () => {
    const { actor } = await mkUser(db, "lab.def.activator", []);
    await activateLabDefinitions(db, actor);
    const report = await activateLabDefinitions(db, actor);
    expect(report.activated).toEqual([]);
    expect(report.alreadyActive.sort()).toEqual([...LAB_DEF_KEYS].sort());
    for (const key of LAB_DEF_KEYS) {
      expect(await listDefinitions(db, key)).toHaveLength(1);
    }
  });
});
