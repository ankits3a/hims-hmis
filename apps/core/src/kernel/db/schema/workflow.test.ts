import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  workflowDefinitions, workflowDefinitionApprovals, workflowInstances, workflowTimers,
} from "./workflow";
import type { Db } from "../client";

const DEF_JSON = {
  key: "test_flow",
  title: "Test Flow",
  changeClass: "C",
  initialState: "open",
  states: [
    { name: "open", sla: { minutes: 30, alerting: "active" } },
    { name: "done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", roles: ["nurse"] }],
};

describe("workflow tables", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("round-trips a definition with jsonb intact and defaults applied", async () => {
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "test_flow", version: 1,
      title: "Test Flow", changeClass: "C", definition: DEF_JSON, draftedBy: "u1",
    });
    const rows = await db.select().from(workflowDefinitions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("draft");
    expect(rows[0]!.definition).toEqual(DEF_JSON);
  });

  it("enforces (defKey, version) uniqueness", async () => {
    const base = { defKey: "test_flow", version: 1, title: "T", changeClass: "C", definition: DEF_JSON, draftedBy: "u1" };
    await db.insert(workflowDefinitions).values({ ...base, id: "01A" });
    await expect(db.insert(workflowDefinitions).values({ ...base, id: "01B" })).rejects.toThrow();
  });

  it("allows only ONE active version per defKey (partial unique index)", async () => {
    const base = { defKey: "test_flow", title: "T", changeClass: "C", definition: DEF_JSON, draftedBy: "u1" };
    await db.insert(workflowDefinitions).values({ ...base, id: "01A", version: 1, status: "active" });
    await expect(
      db.insert(workflowDefinitions).values({ ...base, id: "01B", version: 2, status: "active" }),
    ).rejects.toThrow();
    // retired + draft rows of the same key coexist freely:
    await db.insert(workflowDefinitions).values({ ...base, id: "01C", version: 2, status: "retired" });
    await db.insert(workflowDefinitions).values({ ...base, id: "01D", version: 3 });
  });

  it("approvals are unique per (definitionId, approverId) and FK-checked", async () => {
    await expect(
      db.insert(workflowDefinitionApprovals).values({
        id: "01AP1", definitionId: "missing", approverId: "u2", roleKey: "owner", note: "ok",
      }),
    ).rejects.toThrow(); // FK
    await db.insert(workflowDefinitions).values({
      id: "01HDEF000000000000000000A", defKey: "test_flow", version: 1,
      title: "T", changeClass: "A", definition: DEF_JSON, draftedBy: "u1",
    });
    const approval = {
      definitionId: "01HDEF000000000000000000A", approverId: "u2", roleKey: "owner", note: "ok",
    };
    await db.insert(workflowDefinitionApprovals).values({ ...approval, id: "01AP2" });
    await expect(
      db.insert(workflowDefinitionApprovals).values({ ...approval, id: "01AP3" }),
    ).rejects.toThrow(); // unique (definitionId, approverId)
  });

  it("instances and timers FK back to their parents", async () => {
    await expect(
      db.insert(workflowInstances).values({
        id: "01INST1", definitionId: "missing", defKey: "test_flow", currentState: "open",
        subjectType: "test", subjectId: "s1", stateEnteredAt: new Date(),
      }),
    ).rejects.toThrow(); // FK to definitions
    await expect(
      db.insert(workflowTimers).values({
        id: "01TMR1", instanceId: "missing", state: "open", kind: "sla", dueAt: new Date(),
      }),
    ).rejects.toThrow(); // FK to instances
  });
});
