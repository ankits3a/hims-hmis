import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createDraft, getActiveDefinition, listDefinitions } from "./definitions";
import { WorkflowValidationError } from "./definition";
import { workflowDefinitions, events } from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";

const actor = { type: "user", id: "01HUSER00000000000000000A" } as const;

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

describe("workflow definition drafts", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates version 1 as a draft and emits workflow.definition.updated", async () => {
    const { definitionId, defKey, version } = await createDraft(db, actor, DEF_JSON);
    expect(defKey).toBe("test_flow");
    expect(version).toBe(1);
    const rows = await db.select().from(workflowDefinitions);
    expect(rows[0]!.definition).toEqual(DEF_JSON);
    expect(rows[0]!.id).toBe(definitionId);
    expect(rows[0]!.status).toBe("draft");
    expect(rows[0]!.draftedBy).toBe(actor.id);
    const emitted = await db.select().from(events).where(eq(events.name, "workflow.definition.updated"));
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as { action: string }).action).toBe("drafted");
  });

  it("allocates the next version per defKey", async () => {
    await createDraft(db, actor, DEF_JSON);
    const second = await createDraft(db, actor, DEF_JSON);
    expect(second.version).toBe(2);
  });

  it("rejects an invalid definition without writing anything", async () => {
    await expect(createDraft(db, actor, { ...DEF_JSON, initialState: "nowhere" })).rejects.toThrow(
      WorkflowValidationError,
    );
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("getActiveDefinition returns null until a version is active, then the parsed row", async () => {
    const { definitionId } = await createDraft(db, actor, DEF_JSON);
    await withTx(db, async (tx) => {
      expect(await getActiveDefinition(tx, "test_flow")).toBeNull();
    });
    await db.update(workflowDefinitions)
      .set({ status: "active" })
      .where(eq(workflowDefinitions.id, definitionId)); // direct write: activation itself is Task 5
    await withTx(db, async (tx) => {
      const active = await getActiveDefinition(tx, "test_flow");
      expect(active!.id).toBe(definitionId);
      expect(active!.parsed.initialState).toBe("open");
    });
  });

  it("lists versions newest first", async () => {
    await createDraft(db, actor, DEF_JSON);
    await createDraft(db, actor, DEF_JSON);
    const list = await listDefinitions(db, "test_flow");
    expect(list.map((d) => d.version)).toEqual([2, 1]);
  });
});
