import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { checkPassword } from "../src/kernel/auth/password-policy";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { authManifest } from "../src/kernel/auth/manifest";
import { roleAssignments, rolePermissions, roles, users } from "../src/kernel/db/schema";

/**
 * `pnpm --filter @hmis/core seed:admin` — the bootstrap administrator, and, since Plan 11e T5,
 * THE DOCUMENTED REPAIR IT ALWAYS CLAIMED TO BE.
 *
 * ═══ WHAT WAS WRONG, AND IT SHIPPED TWICE ═══
 *
 * This script used to RETURN EARLY on any deployment that already had an admin — before the grant
 * loop, but AFTER `syncPermissions`. The consequence, MEASURED on production during Plan 11d
 * (MAJOR 1): a permission declared after first boot appeared in the `permissions` catalog and was
 * granted to NOBODY, for ever, because the only script that grants to `admin` had already decided
 * there was nothing to do. Re-running it — the repair every runbook named — printed
 * `already exists — nothing to do` and changed nothing.
 *
 * Plan 11d addendum 5 made `seed:roles` DETECT and NAME that state (its census is MEASURED from
 * `role_permissions` rather than predicted from the model). This is the other half: the repair.
 *
 * ═══ THE SHAPE NOW: EVERY PATH RUNS ON EVERY INVOCATION ═══
 *
 *   1. `syncPermissions` — the catalog. `role_permissions.permission` FKs `permissions.permission`,
 *      so a catalog row must exist before any grant can.
 *   2. ensure the `admin` role — `createRole` is a BARE INSERT and is not idempotent on its own,
 *      so it is select-guarded here exactly as `seed-ops.ts` and `seed-roles.ts` guard it.
 *   3. RECONCILE the grants — every permission in `registry.allPermissions()`, unconditionally.
 *      `grantPermissionToRole` is `onConflictDoNothing`, so this is idempotent by construction.
 *   4. create the user ONLY IF ABSENT. This is the one conditional left, and it is the only one
 *      that should ever have existed: creating a second `admin` is impossible (unique index) and
 *      overwriting an existing admin's password is the silent lockout `seed:staff` refuses to
 *      perform for anybody else.
 *   5. ensure the role assignment — select-guarded, because `assignRole` mints a fresh id on every
 *      call and would otherwise stack duplicate rows on every deploy.
 *
 * IT IS NOT A SECOND EARLY RETURN. Steps 1, 2, 3 and 5 execute on every run; only step 4 branches,
 * and it branches on the one fact that must never be overwritten.
 *
 * ═══ RE-GRANTING ON EVERY DEPLOY IS THE CONTRACT, NOT A RISK ═══
 *
 * `admin`'s grant set is DEFINED as `registry.allPermissions()` of the manifests this script
 * installs. A deliberate revoke of an admin permission is therefore a model change — an edit to a
 * manifest — and not a database state this script is expected to preserve. Anything narrower
 * belongs to a purpose-built role, which is what `seed:roles` exists to mint.
 *
 * ═══ THE REGISTRY IS `authManifest` ALONE, AND THAT IS DELIBERATE ═══
 *
 * `app.module.ts` installs NINE manifests declaring fifty-nine permissions; this script installs
 * ONE. That is not the drift §2.54 warns about — it is the point. `admin` is the break-glass
 * account that can administer ACCESS, not a superuser that silently acquires every permission
 * every future module invents. The other fifty-three permissions are handed to purpose-built roles
 * by `seed:roles`, which is the script that owns the role model.
 *
 * ═══ THE SIXTH POLICY-GUARDED PATH — PLAN 11f D1, RULED 2026-08-24 ═══
 *
 * This script used to carry a STATED SEAM in this header: `ADMIN_PASSWORD` was not checked against
 * `kernel/auth/password-policy.ts`, because 11e D3 enumerated five guarded paths and this bootstrap
 * path was not among them. The gap was real — the FIRST account on a hospital's box could be given
 * a four-character password by an environment variable — and it was written down rather than closed
 * by an executing session on its own authority. Plan 11f D1 is that ruling, and the seam is closed:
 * `ADMIN_PASSWORD` is the SIXTH path the one policy guards.
 *
 * WHERE THE CHECK LANDS, AND WHY IT IS NOT AT THE ENV READ (11f Q2). Step 0 below reads whether the
 * username exists and validates the password ONLY when this run will CREATE it. Validating in
 * `main()`, where the variable is read, would make a RECONCILE-ONLY re-run refuse on a stale or
 * irrelevant `ADMIN_PASSWORD` — and a reconcile-only re-run is precisely the repair 11e D4 built
 * this script to be (MAJOR 1, above). The policy guards the value where the value is USED.
 *
 * The refusal is WHOLE and BEFORE THE FIRST WRITE, the `seed:staff` pattern: every policy problem
 * at once, no credential in any message (GC3), and not one row written — not the catalog, not the
 * role, not a grant. Step 0 is a READ, so there is nothing to unwind.
 */

export type SeedAdminReport = {
  userId: string;
  userCreated: boolean;
  roleCreated: boolean;
  /** Permissions this run actually wrote a `role_permissions` row for. */
  granted: string[];
  /** Permissions `admin` already held — reported rather than silent, so a no-op run says so. */
  already: string[];
  assignmentCreated: boolean;
};

const ADMIN_ROLE_KEY = "admin";

/**
 * A loud, structured refusal carrying EVERY reason at once — `seed-staff.ts`'s `SeedStaffRefusal`,
 * same contract. Every reason is a sentence about a RULE, composed from `password-policy.ts`;
 * `ADMIN_PASSWORD`'s value never reaches one, because an error path is the easiest place in a
 * program to leak a credential.
 */
export class SeedAdminRefusal extends Error {
  readonly reasons: readonly string[];
  constructor(headline: string, reasons: readonly string[]) {
    super(headline);
    this.name = "SeedAdminRefusal";
    this.reasons = reasons;
  }
}

/** The refusal transcript. Loud, ordered, and carrying no credential. */
export function formatRefusal(refusal: SeedAdminRefusal): string[] {
  return [
    "!! REFUSED".padEnd(72, " "),
    `!! ${refusal.message}`,
    ...refusal.reasons.map((reason) => `!! ${reason}`),
    "",
    "Nothing was written. Set a compliant ADMIN_PASSWORD and run this again.",
  ];
}

/**
 * Exported so the suite can run it TWICE against one database, and once with a registry carrying a
 * permission that was not declared on the first run — which is MAJOR 1's discriminating input, and
 * the one the fix could previously only NAME (Book R13).
 */
export async function seedAdmin(
  db: Db,
  registry: ModuleRegistry,
  input: { username: string; fullName: string; password: string },
): Promise<SeedAdminReport> {
  // 0 — THE POLICY GATE (11f D1/Q2). A READ, then a refusal that precedes every write below.
  //
  // The existence check that used to live at step 4 is hoisted here and its result carried down,
  // because the answer decides whether the policy applies at all: this run only judges the password
  // when this run is the one that will SET it. Steps 1-3 do not touch `users`, so hoisting the read
  // changes nothing about what step 4 sees — it only moves the refusal in front of the first write.
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username));
  const userCreated = existing.length === 0;
  if (userCreated) {
    const problems = checkPassword(input.password, { username: input.username });
    if (problems.length > 0) {
      throw new SeedAdminRefusal(
        "ADMIN_PASSWORD does not meet the password policy — NOTHING was written",
        problems.map((problem) => `ADMIN_PASSWORD ${problem.message}`),
      );
    }
  }

  // 1 — the catalog.
  await syncPermissions(db, registry);

  // 2 — the role.
  const haveRole = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, ADMIN_ROLE_KEY));
  const roleCreated = haveRole.length === 0;
  if (roleCreated) await createRole(db, ADMIN_ROLE_KEY, "Administrator");

  // 3 — RECONCILE. Read what is held first, so the report can distinguish "granted now" from
  // "already there" by MEASUREMENT rather than by assuming `onConflictDoNothing` did nothing.
  const heldBefore = new Set(
    (await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleKey, ADMIN_ROLE_KEY))
    ).map((r) => r.permission),
  );
  const granted: string[] = [];
  const already: string[] = [];
  for (const permission of registry.allPermissions()) {
    await grantPermissionToRole(db, registry, ADMIN_ROLE_KEY, permission);
    (heldBefore.has(permission) ? already : granted).push(permission);
  }

  // 4 — the user, and this is the ONLY conditional. Decided at step 0, above, because the policy
  // gate needs the same answer and the tree must not be asked the same question twice (§2.89).
  const userId = userCreated
    ? (await createUser(db, { username: input.username, fullName: input.fullName, password: input.password })).id
    : existing[0]!.id;

  // 5 — the assignment. `assignRole` mints a fresh id per call, so without this guard every deploy
  // would stack another hospital-scope `admin` row on the same person.
  const haveAssignment = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.roleKey, ADMIN_ROLE_KEY)));
  const assignmentCreated = haveAssignment.length === 0;
  if (assignmentCreated) {
    await assignRole(db, { userId, roleKey: ADMIN_ROLE_KEY, scopeType: "hospital" });
  }

  return { userId, userCreated, roleCreated, granted: granted.sort(), already: already.sort(), assignmentCreated };
}

/** The transcript. Returned as lines so its shape is testable and `main` prints it verbatim. */
export function formatReport(username: string, report: SeedAdminReport): string[] {
  return [
    `admin "${username}" (${report.userId}) — ${report.userCreated ? "CREATED" : "already existed"}`,
    `role "${ADMIN_ROLE_KEY}": ${report.roleCreated ? "created" : "already existed"} · ` +
      `assignment: ${report.assignmentCreated ? "created" : "already existed"}`,
    `grants RECONCILED: ${report.granted.length} written now, ${report.already.length} already held ` +
      `(of ${report.granted.length + report.already.length} declared by the installed manifests)`,
    report.granted.length === 0
      ? "nothing new to grant — this deployment was already reconciled"
      : `newly granted: ${report.granted.join(", ")}`,
    "",
    "Re-running this script is the repair for a permission declared after first boot (MAJOR 1). " +
      "It no longer returns early on a deployment that already has an admin.",
  ];
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const username = requireEnv("ADMIN_USERNAME");
  try {
    const report = await seedAdmin(db, registry, {
      username,
      fullName: requireEnv("ADMIN_FULL_NAME"),
      password: requireEnv("ADMIN_PASSWORD"),
    });
    for (const line of formatReport(username, report)) console.log(line);
  } catch (error) {
    // The refusal is an OPERATOR-FACING transcript, not a stack trace: whoever is bootstrapping a
    // hospital's box needs to read what is wrong with the variable, not where the throw happened.
    if (!(error instanceof SeedAdminRefusal)) throw error;
    for (const line of formatRefusal(error)) console.error(line);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  // Deliberately no value from the environment: an error path is the easiest place in a program to
  // leak a credential, and `ADMIN_PASSWORD` is in scope one frame up.
  main().catch((e) => { console.error(e); process.exit(1); });
}
