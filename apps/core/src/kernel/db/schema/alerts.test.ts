import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { alerts } from "./alerts";
import { users } from "./auth";
import type { Db } from "../client";

const USER_A = "01HALERTSUSERA000000000AA";
const USER_B = "01HALERTSUSERB000000000BB";
const EVENT_ID = "01HESCALATIONTRIGGERED001";

const alertRow = (id: string, userId: string, sourceEventId: string = EVENT_ID) => ({
  id, userId, kind: "escalation", title: "opd_wait · waiting · rung 0", sourceEventId,
});

describe("alerts table", () => {
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(users).values([
      { id: USER_A, username: "asha", fullName: "Asha K", passwordHash: "x" },
      { id: USER_B, username: "bala", fullName: "Bala R", passwordHash: "x" },
    ]);
  });
  afterAll(async () => { await teardown(); });

  it("round-trips an alert with its optional columns empty", async () => {
    await db.insert(alerts).values(alertRow("01HALERT00000000000000001", USER_A));
    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBeNull();
    expect(rows[0]!.refType).toBeNull();
    expect(rows[0]!.refId).toBeNull();
    expect(rows[0]!.readAt).toBeNull();
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("is unique on the (source_event_id, user_id) PAIR — one event twice for one user is refused", async () => {
    await db.insert(alerts).values(alertRow("01HALERT00000000000000001", USER_A));
    await expect(
      db.insert(alerts).values(alertRow("01HALERT00000000000000002", USER_A)),
    ).rejects.toThrow();
  });

  it("still fans ONE event out to a SECOND recipient — the pair is the unit, not the event", async () => {
    // Not-over-broad: the roadmap's per-row `source_event_id UNIQUE` would cap one escalation
    // at ONE recipient, and no mutant on the pair-unique catches a uniqueness that is too wide.
    // D6 corrects the shorthand deliberately, so the adjacent allowed case is asserted here.
    await db.insert(alerts).values(alertRow("01HALERT00000000000000001", USER_A));
    await db.insert(alerts).values(alertRow("01HALERT00000000000000002", USER_B));
    expect(await db.select().from(alerts)).toHaveLength(2);
  });

  it("requires user_id to name a real user (the only FK this migration adds, pointing outward)", async () => {
    await expect(
      db.insert(alerts).values(alertRow("01HALERT00000000000000003", "01HNOSUCHUSER00000000000")),
    ).rejects.toThrow();
  });
});
