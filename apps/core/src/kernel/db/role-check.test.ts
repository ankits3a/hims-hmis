import { sql } from "drizzle-orm";
import { setupTestDb } from "../../../test/helpers/db";
import { withTx } from "./client";
import { applyApiDatabaseUrl, warnIfDatabaseSuperuser } from "./role-check";
import type { Db } from "./client";

/**
 * ═══ WASA M-07 (second half) — THE API SAYS SO AT BOOT WHEN IT HOLDS A SUPERUSER CONNECTION ═══
 *
 * A superuser bypasses every append-only trigger (`ALTER TABLE … DISABLE TRIGGER`,
 * `session_replication_role`), owns every table, and turns any future SQL injection into a whole-
 * cluster compromise. Moving production to a non-superuser `hmis_app` role is an operator act
 * (`docs/runbooks/wasa-database-roles.md`); this check is how the operator finds out it is still
 * owed. It WARNS and never refuses: the role is a DEPLOYMENT state an operator can be halfway
 * through, not a code defect CI could catch (the `boot-check-warn-vs-refuse` rule).
 *
 * Two of the three rows assert SILENCE — the correct deployment and the broken probe — which is
 * what makes the one noisy row worth reading in a log.
 */
describe("the database-role boot check", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  const recorder = (): { warn(m: string): void; messages: string[] } => {
    const messages: string[] = [];
    return { warn: (m) => { messages.push(m); }, messages };
  };

  it("R1: WARNS when the connection's role is a superuser, naming the role and the runbook", async () => {
    // The test clusters connect as the image's bootstrap role, which IS a superuser — exactly the
    // production shape this finding describes.
    const who = (await db.execute(sql`select current_user as u`)).rows[0] as { u: string };
    const log = recorder();
    expect(await warnIfDatabaseSuperuser(db, log)).toBe(true);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toContain(`"${who.u}"`);
    expect(log.messages[0]).toContain("SUPERUSER");
    expect(log.messages[0]).toContain("docs/runbooks/wasa-database-roles.md");
  });

  it("R2: says NOTHING under a non-superuser role — the deployment the runbook ends in", async () => {
    const log = recorder();
    const warned = await withTx(db, async (tx) => {
      // A built-in NOLOGIN role that is certainly not a superuser; a superuser may SET ROLE to it,
      // so no cluster-global role has to be created (and cleaned up) for this row.
      await tx.execute(sql`set local role pg_read_all_data`);
      return warnIfDatabaseSuperuser(tx, log);
    });
    expect(warned).toBe(false);
    expect(log.messages).toEqual([]);
  });

  it("R3: a probe that cannot run says nothing and does not throw — an advisory never stops the API", async () => {
    const broken = { execute: () => Promise.reject(new Error("connection refused")) } as unknown as Db;
    const log = recorder();
    expect(await warnIfDatabaseSuperuser(broken, log)).toBe(false);
    expect(log.messages).toEqual([]);
  });

  /**
   * The API's own connection string. Set, it replaces DATABASE_URL for the API process; unset or
   * blank, NOTHING changes — so a deployment that has not created `hmis_app` yet boots exactly as
   * it did, and a blank line left in `.env` cannot point the API at an empty URL.
   */
  it("R4: API_DATABASE_URL replaces DATABASE_URL only when it is set and non-blank", () => {
    const owner = "postgres://hmis:x@db:5432/hmis";
    const app = "postgres://hmis_app:y@db:5432/hmis";
    const set: Record<string, string | undefined> = { DATABASE_URL: owner, API_DATABASE_URL: app };
    expect(applyApiDatabaseUrl(set)).toBe(true);
    expect(set["DATABASE_URL"]).toBe(app);
    for (const blank of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { DATABASE_URL: owner, API_DATABASE_URL: blank };
      expect(applyApiDatabaseUrl(env)).toBe(false);
      expect(env["DATABASE_URL"]).toBe(owner);
    }
  });
});
