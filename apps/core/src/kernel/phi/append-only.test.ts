import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { phiAccessLog } from "../db/schema";
import { withTx } from "../db/client";
import { PHI_ACCESS_RETAIN_DAYS, prunePhiAccessLog } from "./audit";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WASA M-07 — `phi_access_log` IS APPEND-ONLY, WITH EXACTLY ONE DOOR: THE RETENTION PRUNE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * "Who looked at this chart, and when" is the question this table answers, and a log its subject
 * can edit answers nothing. The trigger refuses every UPDATE, and every DELETE except one shape:
 *
 *   the transaction has set `hmis.retention_prune = 'phi_access_log'` (transaction-local, set by
 *   `prunePhiAccessLog` and nothing else) AND the row is older than the DATABASE's floor —
 *   `PHI_ACCESS_RETAIN_DAYS - 1` days by the database's own clock.
 *
 * The setting on its own is NOT the protection — any session can set a custom GUC. The FLOOR is:
 * nothing younger than three years (less one day of clock-skew margin between the worker and the
 * database) can be deleted by anyone below superuser, whatever they set. The setting makes the
 * prune an explicit, named act, so a stray `DELETE FROM phi_access_log` is refused even for rows
 * past the window. Under the role split (`docs/runbooks/wasa-database-roles.md`) the API role
 * holds no DELETE on this table at all, and the prune runs in the worker.
 */

const DAY = 24 * 60 * 60 * 1000;
const APPEND_ONLY = /audit_append_only/;

describe("WASA M-07 — the PHI access log refuses edits, and deletes only through the retention prune", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  async function aRow(ageMs: number): Promise<string> {
    const id = newId();
    await db.insert(phiAccessLog).values({
      id, actorId: "u-reader", actorType: "user", patientId: "p-1", surface: "patient.detail",
      context: "none", at: new Date(Date.now() - ageMs),
    });
    return id;
  }
  const count = async (): Promise<number> => (await db.select().from(phiAccessLog)).length;

  it("P1: an UPDATE is refused — even inside a transaction that set the retention setting", async () => {
    const id = await aRow(DAY);
    await expect(
      db.execute(sql`update phi_access_log set actor_id = 'somebody-else' where id = ${id}`),
    ).rejects.toThrow(APPEND_ONLY);
    await expect(
      withTx(db, async (tx) => {
        await tx.execute(sql`select set_config('hmis.retention_prune', 'phi_access_log', true)`);
        await tx.execute(sql`update phi_access_log set reason = 'rewritten' where id = ${id}`);
      }),
    ).rejects.toThrow(APPEND_ONLY);
    const [row] = await db.select().from(phiAccessLog);
    expect([row!.actorId, row!.reason]).toEqual(["u-reader", null]);
  });

  it("P2: a plain DELETE is refused — even of a row long past the retention window", async () => {
    await aRow((PHI_ACCESS_RETAIN_DAYS + 30) * DAY);
    await expect(db.execute(sql`delete from phi_access_log`)).rejects.toThrow(APPEND_ONLY);
    expect(await count()).toBe(1);
  });

  it("P3: the setting cannot delete a row inside the floor — the floor is the protection, not the setting", async () => {
    await aRow((PHI_ACCESS_RETAIN_DAYS - 2) * DAY);
    await expect(
      withTx(db, async (tx) => {
        await tx.execute(sql`select set_config('hmis.retention_prune', 'phi_access_log', true)`);
        await tx.execute(sql`delete from phi_access_log`);
      }),
    ).rejects.toThrow(APPEND_ONLY);
    expect(await count()).toBe(1);
  });

  it("P4: the retention prune still prunes — a row just past the app's window goes, a fresh one stays", async () => {
    await aRow(PHI_ACCESS_RETAIN_DAYS * DAY + 60 * 60 * 1000); // one hour past the window
    await aRow((PHI_ACCESS_RETAIN_DAYS + 10) * DAY);
    const fresh = await aRow(DAY);
    expect(await prunePhiAccessLog(db)).toBe(2);
    expect((await db.select().from(phiAccessLog)).map((r) => r.id)).toEqual([fresh]);
  });

  it("P5: the prune's setting does not outlive its transaction — the next plain DELETE is refused again", async () => {
    await aRow((PHI_ACCESS_RETAIN_DAYS + 10) * DAY);
    expect(await prunePhiAccessLog(db)).toBe(1);
    await aRow((PHI_ACCESS_RETAIN_DAYS + 10) * DAY);
    // Every pooled connection, not just the one the prune happened to use.
    for (let i = 0; i < 4; i += 1) {
      await expect(db.execute(sql`delete from phi_access_log`)).rejects.toThrow(APPEND_ONLY);
    }
    expect(await count()).toBe(1);
  });

  it("P6: TRUNCATE (the test harness's reset) is not a row delete and still works", async () => {
    await aRow(DAY);
    await truncateAll(db);
    expect(await count()).toBe(0);
  });
});
