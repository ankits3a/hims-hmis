import { eq, inArray } from "drizzle-orm";
import { createDb, withTx, type Db } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { authManifest } from "../src/kernel/auth/manifest";
import { opsManifest } from "../src/kernel/ops/manifest";
import { usersHoldingRole } from "../src/kernel/workflow/roles";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import { rolePermissions, roles } from "../src/kernel/db/schema";

/**
 * `pnpm --filter @hmis/core seed:roles` — the go-live step that makes EVERY module's permissions
 * reachable by somebody (Plan 11d, D1 + D3).
 *
 * WHY THIS EXISTS, because a script nobody understands is a script nobody runs, and because the
 * defect it closes was already closed once for one module and left open for eight.
 *
 *   - `syncPermissions` mirrors permission NAMES into `permissions` at api boot. It is a CATALOG.
 *     It grants nothing to anybody, and it never has.
 *   - Grants are `role_permissions` rows, written only by `grantPermissionToRole`. Before this
 *     script it had exactly TWO non-test callers in the whole tree: `scripts/seed-admin.ts`,
 *     whose registry holds `authManifest` ALONE (six `auth.*` strings) and which returns early on
 *     any deployment that already has an admin, and `scripts/seed-ops.ts`, which grants three
 *     `ops.*` strings.
 *   - `app.module.ts` installs NINE manifests declaring FIFTY-NINE permissions.
 *
 * MEASURED AGAINST PRODUCTION ON 2026-08-24 (plan §B-MEASURED, four read-only SELECTs): the
 * catalog held 59, the only user held 9 — six `auth.*` and three `ops.*` — and FIFTY declared
 * permissions were held by no role at all. Every `opd.*`, `billing.*`, `patients.*`, `tariff.*`,
 * `workflow.*` and `approvals.*` route on the live box answered 403 to the only user who existed:
 * a patient could not be registered and an invoice could not be issued. The README even
 * instructed the owner to fix it by hand — "Grant the `opd.*` permissions per the table above" —
 * naming a tool that did not exist. This is that tool.
 *
 * WHAT IT DOES, all of it idempotent, so it belongs in the re-deploy path forever:
 *   1. installs `ALL_MANIFESTS` and runs `syncPermissions` — `role_permissions.permission` FKs
 *      `permissions.permission`, so the catalog row must exist before any grant can;
 *   2. creates the nine roles of the model below if absent (`createRole` is a BARE INSERT and is
 *      NOT idempotent on its own — `ensureRole` guards it, exactly as `seed-ops.ts` does);
 *   3. grants each role its permissions, skipping rows that already exist so a second run reports
 *      `already` rather than pretending it did work;
 *   4. checks the REACHABILITY INVARIANT — every declared permission is held by at least one
 *      seeded role, or named in `NOT_YET_MODELLED` with a reason — and reports the census;
 *   5. counts holders per role, because a permission nobody holds is a 403 with extra steps;
 *   6. states a readiness verdict in its last line rather than implying one.
 *
 * IT FOLLOWS THE MANIFESTS, NOT THE README. `grantPermissionToRole` refuses any string
 * `registry.allPermissions()` does not contain, which is the leg that turns a typo into a loud
 * failure instead of a permission nobody can ever hold. If a README cell ever names a permission
 * no manifest declares, this script fails and the README is what is wrong.
 *
 * IT ASSIGNS NOBODY, DELIBERATELY. `seed:roles` mints authority; handing it to humans is a
 * separate command, so that "give Asha the cashier role" and "change what a cashier may do" can
 * never be the same act. `opd_admin`, `display` and `pharmacy` therefore get roles with grants
 * and no humans, which is correct — and a role with zero holders APPEARS IN THE REPORT rather
 * than being silently absent, the same discipline `seed-ops.ts` already applies to `owner`.
 *
 * Usage:
 *   pnpm --filter @hmis/core seed:roles
 */

/** One role and every permission the model grants it. */
export type RoleGrants = { roleKey: string; permissions: readonly string[] };

/** A declared permission no role holds yet, with the reason no grant was invented for it. */
export type NotYetModelled = { permission: string; reason: string };

/**
 * THE ROLE MODEL — the source of truth, transcribed cell for cell from the README's two
 * permission tables (the OPD table under "Permissions (14) and the recommended grants" and the
 * billing table under "Recommended permission grants") plus owner ruling 7 of 2026-08-24.
 *
 * `test/seed-roles.test.ts` parses BOTH tables out of `README.md` and compares them against this
 * constant in both directions, so the README cannot drift from it and it cannot drift from the
 * README. The eight `patients.*` pairs are the ONLY rows in this table that appear in neither
 * markdown table, and they are pinned by their own leg of that test against the README prose line
 * that authorises them — a row that is neither table-derived nor one of those eight FAILS.
 */
export const ROLE_MODEL: readonly RoleGrants[] = [
  {
    roleKey: "front_office",
    permissions: [
      "opd.masters.read",
      "opd.appointments.read",
      "opd.appointments.manage",
      "opd.visits.read",
      "opd.visits.open",
      "opd.queue.read",
      // Owner ruling 7 — without these the desk cannot register a patient and the OPD flow this
      // plan exists to enable dies at step one.
      "patients.register",
      "patients.read",
      "patients.update",
    ],
  },
  {
    roleKey: "front_office_supervisor",
    permissions: [
      "opd.masters.read",
      "opd.appointments.read",
      "opd.appointments.manage",
      "opd.visits.read",
      "opd.visits.open",
      "opd.queue.read",
      "opd.queue.transfer",
      "patients.register", // owner ruling 7
      "patients.read",
      "patients.update",
    ],
  },
  {
    roleKey: "vitals_desk",
    permissions: [
      "opd.visits.read",
      "opd.vitals.record",
      "opd.queue.read",
      // Owner ruling 7, and the NARROWER half of it on purpose: vitals are recorded against a
      // patient who already exists, so `patients.register` stays with the two desk roles. A
      // narrow grant can be widened later without anybody being locked out in the meantime.
      "patients.read",
      "patients.update",
    ],
  },
  {
    roleKey: "doctor",
    permissions: [
      "opd.masters.read",
      "opd.appointments.read",
      "opd.visits.read",
      "opd.vitals.record",
      "opd.queue.read",
      "opd.queue.operate",
      "opd.consult",
    ],
  },
  {
    roleKey: "opd_admin",
    permissions: ["opd.masters.read", "opd.masters.manage", "opd.config.manage", "opd.appointments.read"],
  },
  { roleKey: "display", permissions: ["opd.display.read"] },
  { roleKey: "pharmacy", permissions: ["opd.prescriptions.verify"] },
  {
    roleKey: "cashier",
    permissions: [
      "billing.invoice.issue",
      "billing.invoice.read",
      "billing.credit.extend",
      "billing.receipt.record",
      "billing.credit_note.issue",
      "billing.refund.request",
      "billing.refund.pay",
      "billing.session.own",
    ],
  },
  {
    roleKey: "billing_manager",
    permissions: [
      "billing.invoice.read",
      "billing.allocation.reverse",
      "billing.session.read",
      "billing.recon.upload",
      "billing.reports.read",
      "billing.config.write",
      "billing.eie.mark",
      // The billing table's last cell is `approvals.requests.read` / `.decide` — TWO permissions
      // from a DIFFERENT manifest, written as one shorthand. `billing_manager` is the
      // `approverRole` on all five billing approval types, so it needs the generic approvals pair.
      "approvals.requests.read",
      "approvals.requests.decide",
    ],
  },
];

/**
 * THE SEVENTEEN DECLARED PERMISSIONS NO ROLE HOLDS YET, EACH WITH ITS REASON.
 *
 * THIS IS NOT AN EXCEPTIONS LIST AND MUST NOT BE READ AS ONE. An exception says "unreachable on
 * purpose"; every string below says "no owner ruling exists yet". All seventeen guard a real
 * route today, so each is a decision waiting to be made rather than a door deliberately nailed
 * shut — and writing the second as the first is how a gap becomes a decision nobody made.
 *
 * The day any of them gains a holder this list shrinks by one, the census in
 * `test/seed-roles.test.ts` fails, and the commit that grants it has to say so.
 */
export const NOT_YET_MODELLED: readonly NotYetModelled[] = [
  ...[
    "workflow.definitions.draft",
    "workflow.definitions.approve",
    "workflow.definitions.activate",
    "workflow.definitions.read",
    "workflow.instances.start",
    "workflow.instances.transition",
    "workflow.instances.read",
    "workflow.instances.remediate",
  ].map((permission) => ({
    permission,
    reason:
      "workflow activation is a two-key Class A ceremony (README, OPD runbook step 3) whose " +
      "assignment is per-definition and per-environment; no published table models it and no " +
      "owner ruling assigns it to a role key yet",
  })),
  ...[
    "tariff.read",
    "tariff.services.manage",
    "tariff.versions.draft",
    "tariff.versions.activate",
    "tariff.config.manage",
  ].map((permission) => ({
    permission,
    reason:
      "no tariff role model is published anywhere; the pilot's tariff is seeded by script " +
      "(seed:tariff) rather than maintained by a human at a route, and no owner ruling exists yet",
  })),
  {
    permission: "patients.merge",
    reason:
      "merging two patient records is a supervised correction with its own approval path; owner " +
      "ruling 7 granted patients.register/read/update deliberately and stopped short of this one",
  },
  {
    permission: "patients.confidential.read",
    reason:
      "spec section 14 confidential/VIP visibility beyond normal RBAC — it wants an owner ruling " +
      "about WHO may see a confidential record, and Plan 11d does not have one",
  },
  {
    permission: "approvals.types.manage",
    reason:
      "approval TYPES are registered by seed:billing's registerBillingApprovalTypes, not by a " +
      "human at the route; who may edit one at runtime is unruled",
  },
  {
    permission: "approvals.requests.create",
    reason:
      "billing raises its own approval requests inside the issue transaction; no owner ruling " +
      "yet names a human role that creates one directly (the billing table grants only the " +
      "read/decide pair, to billing_manager)",
  },
];

/**
 * The grants OTHER seed scripts already write, derived from the SAME manifests those scripts
 * install so this file cannot become a second copy of them (§2.54). The reachability census
 * counts them as held: they are, on any deployment where those two scripts have run — which
 * production has, measured.
 */
export const GRANTED_BY_OTHER_SEEDS: readonly {
  seed: string;
  roleKey: string;
  permissions: readonly string[];
}[] = [
  { seed: "seed:admin", roleKey: "admin", permissions: authManifest.permissions },
  { seed: "seed:ops", roleKey: "duty_manager", permissions: opsManifest.permissions },
];

/**
 * Titles for the three roles no shipped constant carries. `pharmacy` is a column in the README's
 * OPD permission table and is in NO role-keys constant anywhere in the tree; `cashier` and
 * `billing_manager` are created by `seed:billing` and are absent from `OPD_ROLE_KEYS`. The other
 * six titles are IMPORTED from `OPD_ROLE_KEYS` rather than re-listed, because a fourth copy of
 * "the role keys" is exactly the mechanism this plan exists to close.
 */
export const LOCAL_ROLE_TITLES: Readonly<Record<string, string>> = {
  pharmacy: "Pharmacy (prescription verification)",
  cashier: "Cashier",
  billing_manager: "Billing Manager",
};

/** The title for a model role key. Throws rather than inventing one — an unresolved role is a defect. */
export function roleTitle(roleKey: string): string {
  const fromOpd = OPD_ROLE_KEYS.find((r) => r.key === roleKey);
  if (fromOpd !== undefined) return fromOpd.title;
  const local = LOCAL_ROLE_TITLES[roleKey];
  if (local !== undefined) return local;
  throw new Error(
    `role "${roleKey}" resolves to no title — it is in neither OPD_ROLE_KEYS nor LOCAL_ROLE_TITLES. ` +
      `Add it to LOCAL_ROLE_TITLES in the same commit that adds it to ROLE_MODEL.`,
  );
}

/** Every permission the model itself grants, deduped and sorted. */
export function modelPermissions(): string[] {
  return [...new Set(ROLE_MODEL.flatMap((r) => r.permissions))].sort();
}

/** Every permission held by SOME role once every seed script has run, deduped and sorted. */
export function heldPermissions(): string[] {
  return [
    ...new Set([...modelPermissions(), ...GRANTED_BY_OTHER_SEEDS.flatMap((g) => g.permissions)]),
  ].sort();
}

export type RoleOutcome = {
  roleKey: string;
  title: string;
  created: boolean;
  granted: string[];
  already: string[];
  holders: number;
};

export type SeedRolesReport = {
  declared: number;
  held: number;
  notYetModelled: number;
  roles: RoleOutcome[];
  problems: string[];
  ready: boolean;
};

/** `createRole` is a bare INSERT and is not idempotent. Guarded here exactly as seed-ops.ts guards it. */
async function ensureRole(db: Db, key: string, title: string): Promise<boolean> {
  const existing = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, key));
  if (existing.length > 0) return false;
  await createRole(db, key, title);
  return true;
}

/**
 * Installs every manifest, syncs the catalog, ensures the nine roles, writes the grants, and
 * returns what it did. Exported so the suite can run it TWICE against one database and prove the
 * idempotence claim by execution rather than by reading the code (Book V5).
 */
export async function seedRoles(db: Db): Promise<SeedRolesReport> {
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);
  await syncPermissions(db, registry);

  const modelKeys = ROLE_MODEL.map((r) => r.roleKey);
  const existingGrants = await db
    .select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleKey, modelKeys));
  const alreadyGranted = new Set(existingGrants.map((g) => `${g.roleKey} ${g.permission}`));

  const outcomes: RoleOutcome[] = [];
  for (const { roleKey, permissions } of ROLE_MODEL) {
    const title = roleTitle(roleKey);
    const created = await ensureRole(db, roleKey, title);
    const granted: string[] = [];
    const already: string[] = [];
    for (const permission of permissions) {
      if (alreadyGranted.has(`${roleKey} ${permission}`)) {
        already.push(permission);
        continue;
      }
      // Refuses any string the installed manifests do not declare — the leg that turns a typo
      // into a loud failure instead of a permission nobody can ever hold.
      await grantPermissionToRole(db, registry, roleKey, permission);
      granted.push(permission);
    }
    const holders = await withTx(db, (tx) => usersHoldingRole(tx, roleKey));
    outcomes.push({ roleKey, title, created, granted, already, holders: holders.length });
  }

  const declared = registry.allPermissions();
  const held = new Set(heldPermissions());
  const notYetModelled = new Set(NOT_YET_MODELLED.map((n) => n.permission));

  const problems: string[] = [];
  const orphans = declared.filter((p) => !held.has(p) && !notYetModelled.has(p)).sort();
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} declared permission(s) are held by NO role and are not listed as ` +
        `not-yet-modelled: ${orphans.join(", ")}. Each one is a route that answers 403 to ` +
        `everybody, for ever, with nothing anywhere saying so.`,
    );
  }
  const both = declared.filter((p) => held.has(p) && notYetModelled.has(p)).sort();
  if (both.length > 0) {
    problems.push(
      `${both.length} permission(s) are BOTH granted and listed as not-yet-modelled: ` +
        `${both.join(", ")}. That list is where a gap is recorded, never where a grant is hidden.`,
    );
  }
  const undeclared = [...held, ...notYetModelled].filter((p) => !declared.includes(p)).sort();
  if (undeclared.length > 0) {
    problems.push(
      `${undeclared.length} string(s) in the role model or the not-yet-modelled list are declared ` +
        `by NO installed manifest: ${undeclared.join(", ")}.`,
    );
  }
  const unheld = outcomes.filter((o) => o.holders === 0).map((o) => o.roleKey);
  if (unheld.length === outcomes.length) {
    problems.push(
      `NO USER HOLDS ANY OF THE ${outcomes.length} ROLES — the grants above exist and every one ` +
        `of those routes still answers 403 to every user on this deployment. Roles are minted ` +
        `here and ASSIGNED separately, at hospital scope.`,
    );
  } else if (unheld.length > 0) {
    problems.push(`roles with zero holders: ${unheld.join(", ")} — their routes are reachable by nobody.`);
  }

  return {
    declared: declared.length,
    held: held.size,
    notYetModelled: notYetModelled.size,
    roles: outcomes,
    problems,
    ready: problems.length === 0,
  };
}

/** The transcript. Returned as lines so its shape is testable and `main` prints it verbatim. */
export function formatReport(report: SeedRolesReport): string[] {
  const lines: string[] = [];
  lines.push(`permissions catalog synced from ALL_MANIFESTS: ${report.declared} declared`);
  lines.push("");
  for (const role of report.roles) {
    lines.push(
      `role "${role.roleKey}": ${role.created ? "CREATED" : "already present"} · ` +
        `${role.granted.length} granted, ${role.already.length} already · ${role.holders} holder(s)`,
    );
  }
  lines.push("");
  lines.push(
    `census: ${report.declared} declared · ${report.held} held by a role · ` +
      `${report.notYetModelled} not yet modelled`,
  );
  lines.push(
    "the model is checked against the MANIFESTS, never against the README: grantPermissionToRole " +
      "refuses any string no installed manifest declares.",
  );
  lines.push("");
  if (report.problems.length > 0) {
    lines.push("!! NOT READY".padEnd(72, " "));
    for (const problem of report.problems) lines.push(`!! ${problem}`);
    lines.push("");
    lines.push("Roles and grants are in place; what is named above is not.");
  } else {
    lines.push(
      `READY: every one of the ${report.declared} declared permissions is reachable — ` +
        `${report.held} held by a role, ${report.notYetModelled} recorded as not yet modelled — ` +
        `and every role in the model has at least one holder.`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await seedRoles(db);
    for (const line of formatReport(report)) console.log(line);
  } finally {
    await pool.end();
  }
}

// Guarded so `test/seed-roles.test.ts` can import the model and `seedRoles` without the script
// running itself on import. `tsx scripts/seed-roles.ts` still runs it: apps/core declares no
// `"type": "module"`, so this file is CommonJS and `require.main` is this module.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
