import { eq } from "drizzle-orm";
import { roles, rosterTeams } from "../../src/kernel/db/schema";
import { seedOrgDepartments, seedRosterPositions, seedUnits } from "../../src/modules/roster";
import type { Db } from "../../src/kernel/db/client";

/**
 * 2026-10-04 (owner) — only a CONFIRMED unit counts (`unitCountsAt`). `seedUnits` writes the
 * establishment inactive, as on a real install; a fixture that depicts a hospital RUNNING those units
 * confirms them, exactly as each head would (`confirmTeam`), so the readers see them.
 */
export async function confirmSeededUnits(db: Db): Promise<void> {
  await db.update(rosterTeams).set({ active: true }).where(eq(rosterTeams.kind, "clinical_unit"));
}

/**
 * 2026-10-04 — the roster masters a non-roster suite needs to post a doctor to a unit: the roles the
 * positions are eligible against (only those missing), org departments, positions, the seeded units
 * — every unit CONFIRMED, as a running hospital's would be.
 */
export async function seedConfirmedUnits(db: Db): Promise<void> {
  await db.insert(roles).values(["doctor", "duty_manager", "radiologist", "pathologist", "anaesthetist", "pharmacy"]
    .map((key) => ({ key, title: key }))).onConflictDoNothing();
  await seedOrgDepartments(db);
  await seedRosterPositions(db);
  await seedUnits(db);
  await confirmSeededUnits(db);
}
