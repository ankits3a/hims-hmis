import { sql } from "drizzle-orm";
import type { Db, Tx } from "./client";

/**
 * ═══ WASA M-07 (second half) — THE API WARNS AT BOOT WHEN ITS DATABASE ROLE IS A SUPERUSER ═══
 *
 * The append-only triggers on `events` and `phi_access_log` (and the billing, order and register
 * triggers before them) bind every role EXCEPT a superuser, which can disable any trigger, set
 * `session_replication_role = replica`, drop any table and read any file the server can. Production
 * has connected as the postgres image's bootstrap role — a superuser — since the first deploy, so a
 * single future SQL injection would be a whole-cluster compromise and the audit trail's guarantees
 * would be one statement deep.
 *
 * Moving the API onto the non-superuser `hmis_app` role is an OPERATOR act (role, grants, the api
 * service's DATABASE_URL — `docs/runbooks/wasa-database-roles.md`), not something a migration may
 * do to a live host. This check is how that operator finds out it is still owed.
 *
 * ═══ IT WARNS AND DOES NOT REFUSE ═══
 *
 * The `boot-check-warn-vs-refuse` rule (membership PR #160, `kernel/documents/boot-check.ts`): a
 * refusal is for a CODE defect CI catches; a warning is for a DEPLOYMENT state an operator can
 * legitimately be halfway through. The role is exactly that — and refusing would take every desk in
 * the hospital down to enforce a hardening step. It is silent on the correct deployment (R2 in the
 * test), and a probe that cannot run says nothing rather than throwing (R3): an advisory must never
 * be the thing that stops the API.
 *
 * It runs from `main.ts` — the API process only. The worker and the migrator keep the OWNER role by
 * design (they create and drop event partitions, which only the owner may), so a warning there
 * would fire on the correct deployment and teach everybody to scroll past it.
 */
export function superuserConnectionWarning(role: string): string {
  return `the API is connected to Postgres as "${role}", a SUPERUSER. Every append-only audit `
    + `trigger (events, phi_access_log, billing, registers) is bypassable by a superuser, and any SQL `
    + `injection would own the whole cluster. Run the API as the non-superuser hmis_app role — `
    + `docs/runbooks/wasa-database-roles.md (WASA M-07).`;
}

/**
 * WASA M-07 — THE API PROCESS'S OWN CONNECTION STRING, AND ONLY ITS.
 *
 * `API_DATABASE_URL`, when set and non-empty, replaces `DATABASE_URL` for the long-running API
 * process (`main.ts` calls this before anything reads config). Nothing else reads it: the worker,
 * the migrator and every `compose run --rm api node dist/scripts/…` one-off in `deploy.sh` keep
 * `DATABASE_URL` — the OWNER role — because they create and drop event partitions, run DDL and
 * prune the audit log, none of which the non-superuser `hmis_app` role may do. That is what lets the
 * operator move the internet-facing process onto `hmis_app` with ONE line in the deploy `.env` and
 * no change to `deploy.sh` (docs/runbooks/wasa-database-roles.md §3). Unset, nothing changes.
 *
 * Returns true when it applied the override.
 */
export function applyApiDatabaseUrl(env: Record<string, string | undefined>): boolean {
  const url = env["API_DATABASE_URL"];
  if (url === undefined || url.trim() === "") return false;
  env["DATABASE_URL"] = url;
  return true;
}

/** Where the warning goes. `console` in the API; a recorder in the assertions. */
export type BootLog = { warn(message: string): void };

/** True when it warned, so a test can assert the silence as readily as the noise. */
export async function warnIfDatabaseSuperuser(db: Db | Tx, log: BootLog): Promise<boolean> {
  try {
    // `current_user`, not `session_user`: after a SET ROLE it is the role whose privileges apply.
    const res = await db.execute(sql`
      select r.rolname as role, r.rolsuper as superuser
      from pg_roles r
      where r.rolname = current_user
    `);
    const row = res.rows[0] as { role: string; superuser: boolean } | undefined;
    if (row === undefined || !row.superuser) return false;
    log.warn(superuserConnectionWarning(row.role));
    return true;
  } catch {
    return false; // an advisory that cannot probe says nothing; it does not stop the hospital
  }
}
