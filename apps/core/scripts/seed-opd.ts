import { createDb } from "../src/kernel/db/client";
import { opdConfig, opdDepartments, roles } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { newId } from "@hmis/contracts";
import {
  DEFAULT_DANGER_RANGES, DEFAULT_DEPARTMENTS, DEFAULT_FOLLOW_UP_EXTENSION_DAYS, DEFAULT_LETTERHEAD, OPD_ROLE_KEYS,
} from "../src/modules/opd/config";

/**
 * Seeds the OPD config row (defaults — owner-revised at UAT), the role KEYS the opd_visit definition names, and the
 * placeholder department list. Idempotent: existing rows are left alone. Usage: pnpm --filter @hmis/core seed:opd
 * Grants NOTHING and assigns NOBODY — role grants are the owner's policy (README runbook).
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const cfg = await db.insert(opdConfig).values({
      id: "main", followUpExtensionDays: DEFAULT_FOLLOW_UP_EXTENSION_DAYS, dangerRanges: DEFAULT_DANGER_RANGES,
      letterhead: DEFAULT_LETTERHEAD, updatedBy: "seed",
    }).onConflictDoNothing().returning({ id: opdConfig.id });
    console.log(cfg.length === 1 ? "opd_config seeded (defaults)" : "opd_config exists — left untouched");
    for (const r of OPD_ROLE_KEYS) await db.insert(roles).values({ key: r.key, title: r.title }).onConflictDoNothing();
    console.log(`roles ensured: ${OPD_ROLE_KEYS.map((r) => r.key).join(", ")}`);
    let added = 0;
    for (const d of DEFAULT_DEPARTMENTS) {
      const r = await db.insert(opdDepartments).values({ id: newId(), code: d.code, name: d.name, createdBy: "seed", updatedBy: "seed" }).onConflictDoNothing().returning({ id: opdDepartments.id });
      added += r.length;
    }
    console.log(`departments: ${added} added, ${DEFAULT_DEPARTMENTS.length - added} already present`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
