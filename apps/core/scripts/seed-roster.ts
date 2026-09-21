import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { seedOrgDepartments, seedRosterPositions, seedUnits } from "../src/modules/roster";

/**
 * PHASE R (R1) — seeds the two master lists the roster is keyed on: the hospital's organisational
 * departments (linked to their OPD clinic by code, where they run one) and the seventeen duty
 * positions. Idempotent: an existing row is left exactly as it is, because by the second deploy a
 * human has renamed a department or deactivated a position and a seed that "corrected" them would
 * be a seed that silently undid somebody's decision.
 *
 * ORDER: after `seed:roles` (the positions name RBAC roles they are eligible against) and after
 * `seed:opd` (the twelve clinics must exist for the link to resolve; without them the twelve
 * clinical departments are still seeded, just unlinked, and re-running after `seed:opd` does NOT
 * backfill the link — `standup:check` is where that is reported).
 *
 * Usage: pnpm --filter @hmis/core seed:roster
 * Grants NOTHING and assigns NOBODY — role grants are the owner's policy (README runbook).
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const d = await seedOrgDepartments(db);
    console.log(`org_departments: ${d.added} added, ${d.present} already present`);
    const p = await seedRosterPositions(db);
    console.log(`roster_positions: ${p.added} added, ${p.present} already present`);
    const u = await seedUnits(db);
    console.log(`roster_teams: ${u.added} added, ${u.present} already present — ALL INACTIVE:`);
    console.log("  the 27-unit establishment is this hospital's own (UG-MSR 2023 dropped the units");
    console.log("  table), so each head of department confirms their units before anything rosters");
    console.log("  against them. `pnpm --filter @hmis/core standup:check` lists what is unconfirmed.");
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
