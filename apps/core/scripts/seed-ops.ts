import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { usersHoldingRole } from "../src/kernel/workflow/roles";
import { OWNER_ROLE, DUTY_MANAGER_ROLE } from "../src/kernel/alerts/consumer";
import {
  opsManifest,
  OPS_MODE_SET,
  OPS_DOWNTIME_GENERATE,
  OPS_INTERFACE_MANAGE,
} from "../src/kernel/ops/manifest";
import { roles, users } from "../src/kernel/db/schema";

/**
 * `pnpm seed:ops` — the go-live step that makes Plan 11c's operating-mode surface REACHABLE.
 *
 * WHY THIS EXISTS, because a script nobody understands is a script nobody runs. Plan 11c's
 * discovery review (gate report MAJOR 4) found that NOTHING in this repository could grant the
 * three `ops.*` permissions on a live deployment:
 *
 *   - `syncPermissions` mirrors permission NAMES into `permissions` at api boot and grants
 *     nothing to any role — it is a catalog, not an authorisation.
 *   - Grants are `role_permissions` rows, written only by `grantPermissionToRole`, whose single
 *     non-test caller was `scripts/seed-admin.ts` — which returns early on any deployment that
 *     already has an admin user, and which installs `authManifest` ALONE, so even on a virgin
 *     database it grants six `auth.*` strings and nothing else.
 *   - There is no HTTP surface: `auth.roles.manage` is declared by a manifest and used by no
 *     route anywhere in the tree.
 *
 * The consequence, had 11c been deployed as it stood: `POST /ops/mode` (declare downtime) and
 * `POST /ops/downtime-kits` (print the paper) would answer 403 to EVERY user, and the mode-desk
 * and downtime-kit nav links would lead to screens whose every action is refused. The emergency
 * path would have been the one thing nobody could reach.
 *
 * WHAT IT DOES, all of it idempotent, so it belongs in the re-deploy path forever:
 *   1. installs `opsManifest` and runs `syncPermissions` — `role_permissions.permission` FKs
 *      `permissions.permission`, so the catalog row must exist before any grant can;
 *   2. creates the `duty_manager` and `owner` roles if absent (`createRole` is a bare insert and
 *      is NOT idempotent on its own — it is guarded here);
 *   3. grants all three `ops.*` permissions to `duty_manager` — D2's ruling is that declare and
 *      recover authority IS `ops.mode.set`, held by the duty-manager role;
 *   4. grants the same three to `admin` IF that role already exists — not speculation: the
 *      runbook documents `admin` as the role holding every manifest permission, and the drift
 *      between that sentence and `seed-admin.ts`'s six-string reality is precisely what produced
 *      MAJOR 4. A role that the documentation says is a superuser and that silently is not is
 *      the same defect one level up;
 *   5. optionally ASSIGNS named humans (below), because a permission nobody holds is a 403 with
 *      extra steps;
 *   6. reports membership and states a readiness verdict in its last line.
 *
 * IT GRANTS NOTHING TO `owner` DELIBERATELY. Map 1's rule is that the owner is ALERTED and is
 * never required to act; `usersHoldingRole(tx, OWNER_ROLE)` is the mode-alert fan-out's recipient
 * list, and receiving an alert needs no permission at all. The role is created here so that fan-out
 * has somewhere to land — an `owner` role with zero holders means every downtime declaration
 * raises an alert for nobody, which is exactly the silence D11 was written to abolish, and which
 * is why the report below counts holders rather than assuming them.
 *
 * Usage:
 *   pnpm seed:ops                                    # roles + grants only
 *   OPS_DUTY_MANAGERS=asha,ravi pnpm seed:ops        # ...and assign those usernames
 *   OPS_OWNERS=ankit pnpm seed:ops                   # ...and who gets woken at 03:00
 *
 * A username that does not exist is a hard ERROR, never a skip: silently ignoring a typo is how
 * an operator ends up believing a duty manager was appointed when nobody was.
 */

const OPS_PERMISSIONS = [OPS_MODE_SET, OPS_DOWNTIME_GENERATE, OPS_INTERFACE_MANAGE] as const;

/** Comma-separated usernames from an env var; empty when unset or blank. */
function usernamesFrom(key: string): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
}

async function ensureRole(db: ReturnType<typeof createDb>["db"], key: string, title: string): Promise<boolean> {
  const existing = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, key));
  if (existing.length > 0) return false;
  await createRole(db, key, title);
  return true;
}

/** Assigns `roleKey` to each username at hospital scope, skipping anyone who already holds it. */
async function assignAll(
  db: ReturnType<typeof createDb>["db"],
  usernames: string[],
  roleKey: string,
): Promise<{ assigned: string[]; already: string[] }> {
  const assigned: string[] = [];
  const already: string[] = [];
  const holders = new Set(await withTx(db, (tx) => usersHoldingRole(tx, roleKey)));
  for (const username of usernames) {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `no user "${username}" — refusing to continue. A username that does not exist is a typo, ` +
          `and skipping it silently would leave you believing a ${roleKey} was appointed when none was.`,
      );
    }
    if (holders.has(row.id)) {
      already.push(username);
      continue;
    }
    await assignRole(db, { userId: row.id, roleKey, scopeType: "hospital" });
    assigned.push(username);
  }
  return { assigned, already };
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const registry = new ModuleRegistry();
    registry.install(opsManifest);
    await syncPermissions(db, registry);
    console.log(`permissions catalog synced: ${OPS_PERMISSIONS.join(", ")}`);

    // 2. Roles.
    for (const [key, title] of [
      [DUTY_MANAGER_ROLE, "Duty manager"],
      [OWNER_ROLE, "Owner"],
    ] as const) {
      const created = await ensureRole(db, key, title);
      console.log(`role "${key}": ${created ? "CREATED" : "already present"}`);
    }

    // 3 + 4. Grants. `grantPermissionToRole` is onConflictDoNothing, so re-runs are free; it
    // refuses any permission the installed registry does not declare, which is the guard that
    // makes an unreachable-permission typo impossible here.
    const grantTargets = [DUTY_MANAGER_ROLE];
    const haveAdmin = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, "admin"));
    if (haveAdmin.length > 0) grantTargets.push("admin");
    for (const roleKey of grantTargets) {
      for (const permission of OPS_PERMISSIONS) {
        await grantPermissionToRole(db, registry, roleKey, permission);
      }
      console.log(`granted ${OPS_PERMISSIONS.length} ops permissions to "${roleKey}"`);
    }
    if (haveAdmin.length === 0) {
      console.log(`role "admin" is absent — skipped (run pnpm seed:admin first if you want one)`);
    }

    // 5. Optional assignment.
    for (const [envKey, roleKey] of [
      ["OPS_DUTY_MANAGERS", DUTY_MANAGER_ROLE],
      ["OPS_OWNERS", OWNER_ROLE],
    ] as const) {
      const names = usernamesFrom(envKey);
      if (names.length === 0) continue;
      const { assigned, already } = await assignAll(db, names, roleKey);
      if (assigned.length > 0) console.log(`assigned "${roleKey}" to: ${assigned.join(", ")}`);
      if (already.length > 0) console.log(`already held "${roleKey}": ${already.join(", ")}`);
    }

    // 6. The report, and the verdict.
    const dutyHolders = await withTx(db, (tx) => usersHoldingRole(tx, DUTY_MANAGER_ROLE));
    const ownerHolders = await withTx(db, (tx) => usersHoldingRole(tx, OWNER_ROLE));
    console.log("");
    console.log(`duty_manager holders: ${dutyHolders.length}`);
    console.log(`owner holders:        ${ownerHolders.length}`);

    const problems: string[] = [];
    if (dutyHolders.length === 0) {
      problems.push(
        "NO USER HOLDS duty_manager — every /ops route still answers 403 and nobody can declare " +
          "downtime or print a kit. Re-run with OPS_DUTY_MANAGERS=<usernames>.",
      );
    }
    if (ownerHolders.length === 0) {
      problems.push(
        "NO USER HOLDS owner — a downtime or degraded declaration raises an alert for NOBODY " +
          "(the fan-out reads usersHoldingRole(owner)). Re-run with OPS_OWNERS=<usernames>.",
      );
    }

    if (problems.length > 0) {
      console.log("");
      console.log("!! NOT READY".padEnd(72, " "));
      for (const p of problems) console.log(`!! ${p}`);
      console.log("");
      console.log("Roles and grants are in place; the human assignments are not.");
    } else {
      console.log("");
      console.log("READY: duty managers can declare downtime and generate kits; owners will be alerted.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
