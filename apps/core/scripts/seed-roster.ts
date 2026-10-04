import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { SURPLUS_REASON, retireSurplusUnits, seedOrgDepartments, seedRosterPositions, seedRosterRules, seedUnits } from "../src/modules/roster";
import type { Db } from "../src/kernel/db/client";

type SeedCount = Awaited<ReturnType<typeof seedUnits>>;
export interface RosterSeedReport {
  departments: SeedCount; positions: SeedCount; units: SeedCount; rules: SeedCount;
  /** 2026-10-04 — surplus seeded teams closed (never confirmed), and confirmed ones left for a human. */
  surplus: { retired: string[]; keptConfirmed: string[] };
}

/** The seed as a function, so a test runs exactly what the script runs. */
export async function seedRoster(db: Db): Promise<RosterSeedReport> {
  const departments = await seedOrgDepartments(db);
  const positions = await seedRosterPositions(db);
  const units = await seedUnits(db);
  const surplus = await retireSurplusUnits(db, "seed:roster");
  const rules = await seedRosterRules(db);
  return { departments, positions, units, rules, surplus };
}

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
 * ═══ AND THE RULE BOOK (owner 2026-10-04) ═══
 *
 * `seedRosterRules` (`modules/roster/rules.ts`, R8) existed and NOTHING called it outside tests, so
 * `roster_rules` was empty on every install and `publishPeriod`'s gate judged every roster against no
 * rules at all. It runs here now, under the same idempotence as the masters above: a rule is keyed by
 * `key` and inserted with `on conflict do nothing`, so a rule the owner has re-weighted, re-worded or
 * deactivated is left EXACTLY as he left it. A department's moved numbers are `roster_rule_profiles`
 * rows, which this seed never touches. Re-running adds only a rule a later release introduced.
 *
 * Usage: pnpm --filter @hmis/core seed:roster
 * Grants NOTHING and assigns NOBODY — role grants are the owner's policy (README runbook).
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const { departments: d, positions: p, units: u, rules: r, surplus } = await seedRoster(db);
    console.log(`org_departments: ${d.added} added, ${d.present} already present`);
    console.log(`roster_positions: ${p.added} added, ${p.present} already present`);
    console.log(`roster_teams: ${u.added} added, ${u.present} already present — ALL INACTIVE:`);
    console.log("  the 22-unit establishment is the owner's table of 2026-10-04 (UG-MSR 2023 dropped the units");
    console.log("  table), so each head of department confirms their units before anything rosters");
    console.log("  against them. `pnpm --filter @hmis/core standup:check` lists what is unconfirmed.");
    console.log(`surplus teams closed (${SURPLUS_REASON}): ${surplus.retired.length === 0 ? "none" : surplus.retired.join(", ")}`);
    if (surplus.keptConfirmed.length > 0) console.log(`  CONFIRMED surplus left for a human to close: ${surplus.keptConfirmed.join(", ")}`);
    console.log(`roster_rules: ${r.added} added, ${r.present} already present — the publish gate judges by these`);
  } finally {
    await pool.end();
  }
}
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
