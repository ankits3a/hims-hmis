import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { appendEvent } from "./append";
import { SubscriptionBus } from "./subscriptions";
import { runDispatchCycle } from "./dispatcher";
import { withTx, Db } from "../db/client";

const mkInput = (name: string) => ({
  name, version: 1, occurredAt: new Date(),
  actor: { type: "system" as const, id: "test" }, module: "opd",
  payload: { n: name }, siteId: "main",
});

describe("runDispatchCycle", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("delivers matching events once and advances the cursor", async () => {
    const seen: string[] = [];
    const bus = new SubscriptionBus();
    bus.on("billing.autoCharge", "visit.opened", async (e) => { seen.push(e.eventId); });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await withTx(db, (tx) => appendEvent(tx, mkInput("patient.registered")));
    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    expect(await runDispatchCycle(db, bus)).toBe(2);
    expect(seen).toHaveLength(2);
    expect(await runDispatchCycle(db, bus)).toBe(0); // nothing redelivered
  });

  it("does not advance the cursor past a failing handler", async () => {
    let calls = 0;
    const bus = new SubscriptionBus();
    bus.on("flaky.consumer", "visit.opened", async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await runDispatchCycle(db, bus); // handler throws; swallowed per-consumer
    expect(calls).toBe(1);
    expect(await runDispatchCycle(db, bus)).toBe(1); // redelivered
    expect(calls).toBe(2);
  });

  it("isolates consumers — one failing consumer does not block another", async () => {
    const okSeen: string[] = [];
    const bus = new SubscriptionBus();
    bus.on("bad.consumer", "visit.opened", async () => { throw new Error("always"); });
    bus.on("good.consumer", "visit.opened", async (e) => { okSeen.push(e.eventId); });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await runDispatchCycle(db, bus);
    expect(okSeen).toHaveLength(1);
  });
});
