import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { assertNotSodPair, seedSodPairs, SodViolationError, SOD_PAIR_SEED } from "./sod";
import { withTx } from "../db/client";
import { events } from "../db/schema";
import type { Db } from "../db/client";

const userA = { type: "user" as const, id: "01HUSERAAAAAAAAAAAAAAAAAA0" };
const userB = { type: "user" as const, id: "01HUSERBBBBBBBBBBBBBBBBBB0" };

describe("sod", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); });
  afterAll(async () => { await teardown(); });

  it("seeds all nine S10 pairs idempotently", async () => {
    expect(SOD_PAIR_SEED).toHaveLength(9);
    await seedSodPairs(db); // second run must not throw
  });

  it("distinct actors pass without an event", async () => {
    await assertNotSodPair(db, "requester_approver", userA, userB);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("unknown pair keys throw without an event", async () => {
    await expect(assertNotSodPair(db, "not_a_pair", userA, userA)).rejects.toThrow(/unknown SoD pair/);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("same actor blocks with sod.violation_blocked", async () => {
    await expect(assertNotSodPair(db, "cashier_refund_approver", userA, userA))
      .rejects.toThrow(SodViolationError);
    const rows = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("auth");
    expect((rows[0]!.payload as { pairKey: string }).pairKey).toBe("cashier_refund_approver");
  });

  it("the violation event survives the caller's rollback", async () => {
    await expect(
      withTx(db, async (tx) => {
        void tx; // caller doing its own transactional work…
        await assertNotSodPair(db, "narcotics_issuer_witness", userB, userB);
      }),
    ).rejects.toThrow(SodViolationError);
    // caller's tx rolled back, but the block is still on the record:
    const rows = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(rows).toHaveLength(1);
  });
});
