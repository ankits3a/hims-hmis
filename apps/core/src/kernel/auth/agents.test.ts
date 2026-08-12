import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createAgent, findAgentByKey, setKillSwitch } from "./agents";
import type { Db } from "../db/client";

describe("agents", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates an agent and finds it by key", async () => {
    const { id, apiKey } = await createAgent(db, "digest-writer");
    const found = await findAgentByKey(db, apiKey);
    expect(found).toEqual({ id, name: "digest-writer", killSwitch: false });
    expect(await findAgentByKey(db, "wrong-key")).toBeNull();
  });

  it("kill switch state is visible on lookup", async () => {
    const { id, apiKey } = await createAgent(db, "sla-chaser");
    await setKillSwitch(db, id, true);
    expect((await findAgentByKey(db, apiKey))!.killSwitch).toBe(true);
  });

  it("rejects duplicate agent names", async () => {
    await createAgent(db, "digest-writer");
    await expect(createAgent(db, "digest-writer")).rejects.toThrow();
  });
});
