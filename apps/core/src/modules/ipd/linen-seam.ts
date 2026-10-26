import { sql } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * LD-1 (#978) — what the laundry needs from IPD, by bed and never by patient:
 *   · the beds whose admission is declared fit with a target time in the window (tomorrow's rush demand for sets);
 *   · the occupied beds whose admission is an MLC (the pickup sheet suggests an MLC hold there).
 * Read through this file only; linen never reads the admission tables itself.
 */
export async function plannedDischargeBeds(exec: Db | Tx, from: Date, to: Date): Promise<string[]> {
  const r = await exec.execute<{ bed: string }>(sql`
    select r.id as bed from ipd_discharges d
      join resources r on r.kind = 'bed' and r.occupant_type = 'ipd_admission' and r.occupant_ref = d.admission_id
     where d.status = 'active' and d.target_at >= ${from.toISOString()}::timestamptz and d.target_at < ${to.toISOString()}::timestamptz`);
  return r.rows.map((x) => x.bed);
}

export async function mlcOccupiedBeds(exec: Db | Tx): Promise<string[]> {
  const r = await exec.execute<{ bed: string }>(sql`
    select r.id as bed from resources r join ipd_admissions a on a.id = r.occupant_ref
     where r.kind = 'bed' and r.occupant_type = 'ipd_admission' and a.mlc`);
  return r.rows.map((x) => x.bed);
}
