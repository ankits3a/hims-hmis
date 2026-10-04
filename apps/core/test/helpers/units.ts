import { eq } from "drizzle-orm";
import { rosterTeams } from "../../src/kernel/db/schema";
import type { Db } from "../../src/kernel/db/client";

/**
 * 2026-10-04 (owner) — only a CONFIRMED unit counts (`unitCountsAt`). `seedUnits` writes the
 * establishment inactive, as on a real install; a fixture that depicts a hospital RUNNING those units
 * confirms them, exactly as each head would (`confirmTeam`), so the readers see them.
 */
export async function confirmSeededUnits(db: Db): Promise<void> {
  await db.update(rosterTeams).set({ active: true }).where(eq(rosterTeams.kind, "clinical_unit"));
}
