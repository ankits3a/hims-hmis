import { sql } from "drizzle-orm";
import { IPD_PLACED_STATES } from "./admission-place";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E4.4 DIET (#736) — WHO LIES ON A BED NOW, AND IN WHICH WARD, for the kitchen's meal lists. Read-only; diet reaches it
 * through `ipd/index.ts`. One query for the whole hospital (a meal list is built for every ward at once): every placed
 * admission with its open bed stay, the bed's code, and the nearest ward or hall above the bed (a recursive walk up
 * `resources.parent_id`, at most four steps — deeper than any layout the bed loader accepts).
 */
export type PlacedPatient = {
  admissionId: string;
  patientId: string;
  bedId: string;
  bedCode: string;
  wardId: string;
  wardCode: string;
  wardName: string;
  admittedAt: Date | null;
};

export async function placedCensus(exec: Db | Tx, wardId?: string): Promise<PlacedPatient[]> {
  const states = sql.join(IPD_PLACED_STATES.map((s) => sql`${s}`), sql`, `);
  const res = await (exec as Db).execute(sql`
    with recursive up as (
      select s.admission_id, b.id as bed_id, b.code as bed_code, b.parent_id as next_id, 0 as depth
        from ipd_bed_stays s join resources b on b.id = s.bed_id
       where s.ended_at is null
      union all
      select up.admission_id, up.bed_id, up.bed_code, r.parent_id, up.depth + 1
        from up join resources r on r.id = up.next_id
       where r.kind not in ('ward', 'hall') and up.depth < 4
    )
    select a.id as "admissionId", a.patient_id as "patientId", up.bed_id as "bedId", up.bed_code as "bedCode",
           w.id as "wardId", w.code as "wardCode", w.name as "wardName", a.admitted_at as "admittedAt"
      from up
      join resources w on w.id = up.next_id and w.kind in ('ward', 'hall')
      join ipd_admissions a on a.id = up.admission_id
     where a.state in (${states}) ${wardId === undefined ? sql`` : sql`and w.id = ${wardId}`}
     order by w.name, up.bed_code`);
  return (res.rows as Array<Omit<PlacedPatient, "admittedAt"> & { admittedAt: string | Date | null }>).map((r) => ({
    ...r, admittedAt: r.admittedAt === null ? null : new Date(r.admittedAt),
  }));
}
