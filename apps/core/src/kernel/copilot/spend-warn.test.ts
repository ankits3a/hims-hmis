import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser } from "../../../test/helpers/opd";
import { createRole } from "../auth/permissions";
import { alerts } from "../db/schema";
import { COPILOT_SPEND_WARN_KIND, warnOwnersNearCap } from "./spend-warn";
import type { Db } from "../db/client";

/**
 * #583 (E0.5, decision 0064) — AT 80 % OF THE DAY'S CAP THE OWNER IS WARNED, ONCE PER IST DAY.
 * The cap itself (phrasebook-only at 100 %) is `test/copilot-halt.e2e.test.ts`. Clocks are injected.
 */
describe("#583 — the 80 % warning to the owner", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const CAP = 5_000_000_000; // ₹5,000 in micro-rupees
  const AT = new Date("2030-01-15T06:00:00.000Z"); // 11:30 IST
  const NEXT_DAY = new Date("2030-01-15T19:00:00.000Z"); // 00:30 IST on the 16th

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); await createRole(db, "owner", "Owner"); await createRole(db, "desk", "Desk"); });
  afterAll(async () => { await teardown(); });

  const warnings = async (userId: string) =>
    db.select().from(alerts).where(eq(alerts.userId, userId)).then((r) => r.filter((a) => a.kind === COPILOT_SPEND_WARN_KIND));

  it("below 80 % nobody is told; crossing it tells every owner once, and the next IST day may tell them again", async () => {
    const owner = await mkUser(db, "spend_owner", ["owner"]);
    const clerk = await mkUser(db, "spend_clerk", ["desk"]);
    expect(await warnOwnersNearCap(db, { spentMicroInr: CAP * 0.79, capMicroInr: CAP, now: AT })).toBe(0);
    expect(await warnings(owner.id)).toHaveLength(0);

    expect(await warnOwnersNearCap(db, { spentMicroInr: CAP * 0.8, capMicroInr: CAP, now: AT })).toBe(1);
    expect(await warnOwnersNearCap(db, { spentMicroInr: CAP * 0.95, capMicroInr: CAP, now: AT })).toBe(0);
    const rows = await warnings(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("80%");
    expect(await warnings(clerk.id)).toHaveLength(0);

    expect(await warnOwnersNearCap(db, { spentMicroInr: CAP * 0.85, capMicroInr: CAP, now: NEXT_DAY })).toBe(1);
    expect(await warnings(owner.id)).toHaveLength(2);
  });

  it("a cap of zero warns nobody (the brake is off, not tripped)", async () => {
    await mkUser(db, "spend_owner2", ["owner"]);
    expect(await warnOwnersNearCap(db, { spentMicroInr: 10, capMicroInr: 0, now: AT })).toBe(0);
  });
});
