import { sql } from "drizzle-orm";
import { LINEN_ROUND_SLOTS, newId } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { linenRounds } from "../../kernel/db/schema";
import { LINEN_CLOCK_ID, releaseExpiredHolds } from "./holds";
import type { LinenRoundKind } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE LINEN CLOCK (LD-1, #978) ═══ — run every minute by the worker while the module is on.
 *   · Chemotherapy holds whose 48 hours are over are released (D4).
 *   · Each ward live on linen gets its scheduled rounds (IST slots, `LINEN_ROUND_SLOTS`) once a slot's time has come,
 *     for slots in the last two hours only: a worker down overnight does not wake to a morning of stale rounds. A slot's
 *     round is one row (`linen_rounds_slot_uq`), so running the clock again raises nothing new.
 */
export const LINEN_ROUND_CATCH_UP_MS = 2 * 3_600_000;

/** Today's slot instants (IST) of each kind that fall in (now − catch-up, now]. */
export function dueSlots(now: Date): { kind: LinenRoundKind; at: Date }[] {
  const { start } = istDayWindow(now);
  const out: { kind: LinenRoundKind; at: Date }[] = [];
  for (const kind of ["pickup", "delivery"] as const) {
    for (const hhmm of LINEN_ROUND_SLOTS[kind]) {
      const [h, m] = hhmm.split(":").map(Number) as [number, number];
      const at = new Date(start.getTime() + (h * 60 + m) * 60_000);
      if (at <= now && now.getTime() - at.getTime() < LINEN_ROUND_CATCH_UP_MS) out.push({ kind, at });
    }
  }
  return out;
}

export async function runLinenClock(db: Db, now: Date = new Date()): Promise<{ holdsReleased: number; roundsRaised: number }> {
  const holdsReleased = await releaseExpiredHolds(db, now);
  const slots = dueSlots(now);
  let roundsRaised = 0;
  if (slots.length > 0) {
    // A ward is live on linen once it has been counted or has moved linen.
    const wards = (await db.execute<{ id: string }>(sql`
      select r.id from resources r where r.kind = 'ward' and r.status <> 'retired'
         and (exists (select 1 from linen_ward_counts c where c.ward_resource_id = r.id)
           or exists (select 1 from linen_movements m where m.ward_resource_id = r.id))`)).rows.map((r) => r.id);
    for (const wardId of wards) {
      for (const s of slots) {
        const rows = await db.insert(linenRounds).values({
          id: newId(), wardResourceId: wardId, kind: s.kind, state: "open", slotAt: s.at, createdBy: LINEN_CLOCK_ID, createdAt: now,
        }).onConflictDoNothing().returning({ id: linenRounds.id });
        roundsRaised += rows.length;
      }
    }
  }
  return { holdsReleased, roundsRaised };
}
