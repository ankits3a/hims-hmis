import { sql } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";

export type EquivalentMedicine = {
  id: string;
  brandName: string;
  strengthLabel: string | null;
  form: string;
  routeClass: string;
  scheduleFlag: string | null;
};

type Row = {
  id: string;
  brand_name: string;
  strength_label: string | null;
  form: string;
  route_class: string;
  schedule_flag: string | null;
};

/**
 * ═══ GENERIC EQUIVALENCE, ONCE, IN SQL ═══
 *
 * Two medicines are equivalent when they are made of the SAME SET of moieties at the same strength
 * label, in the same form, by the same route. That sentence was written twice in JS — once to
 * decide what the substitution dropdown OFFERS and once to decide what the dispensing gate
 * ACCEPTS — and nothing tested that the two agreed. Two copies of one rule drift, and these two
 * drifting means a counter is offered a substitution that verify then refuses, or worse, the
 * reverse. So there is one predicate and both callers are it: `isEquivalentMedicine` is literally
 * `equivalentMedicines(from, { among: [to] }).length === 1`, the same string of SQL, which is the
 * whole point of this file.
 *
 * ═══ WHY EVERY CLAUSE IS THERE ═══
 *
 * - `(select count(*) from want) > 0` is the SQL form of the old `if (wanted === "") return []`.
 *   Without it, two UNCOMPOSED medicines satisfy `0 = 0` and a vacuously-true anti-join, and any
 *   brand with no composition substitutes for any other. That is not hypothetical: the catalogue
 *   importer emits composition-less products, 8 of them on the real national bundle.
 * - `count(*) = count(want)` kills the strict SUBSET; the double `not exists` kills the strict
 *   SUPERSET. The pair is a sound SET EQUALITY only because `formulary_medicine_salts`' primary key
 *   is `(medicine_id, salt_id)`, so a duplicate row is unstorable and `count(*)` IS the distinct
 *   moiety count. That constraint is what licenses counting instead of comparing sorted arrays.
 * - `coalesce(strength_label, '')` on BOTH sides. Plain `=` is NULL when both are NULL, so two
 *   unlabelled medicines would quietly stop being equivalent. Reproduces the old
 *   `(a.strengthLabel ?? "") === (b.strengthLabel ?? "")`.
 * - `and m.active` on the SOURCE reproduces the old lookup through an active-only list returning
 *   undefined; `and c.active` does the same for the candidate.
 *
 * ═══ `among` IS REQUIRED, AND THAT IS THE BOUND ═══
 *
 * Not an optional filter — a mandatory universe. Measured on the loaded national catalogue: 9,930
 * equivalence classes over 103,383 active medicines, mean 10.41, p99 191, max 1,581. An unbounded
 * answer is a list nobody can render and an offer no counter can keep. The pharmacy passes its own
 * SHELF, which is hundreds of items, so the cost is a property of the hospital rather than of the
 * nation. Measured: shelf of 305 → 5 ms; shelf of 999 → 17 ms; and 70,000 ids in the one array
 * parameter → 242 ms and no protocol error, so the bound is a design choice, not a crutch.
 *
 * ═══ SCHEDULE IS DELIBERATELY NOT IN HERE ═══
 *
 * A refused schedule is a law about DISPENSING, not a fact about COMPOSITION. `schedule_flag` is
 * returned so the caller applies its own `REFUSED_FLAGS`; folding it in would turn a precise
 * `schedule_x_not_dispensed_here` into a vague `substitution_not_allowed`. The law is asked at
 * every gate that can name a medicine, which is where it belongs.
 */
export async function equivalentMedicines(
  db: Db | Tx,
  medicineId: string,
  opts: { among: readonly string[] },
): Promise<EquivalentMedicine[]> {
  const among = [...new Set(opts.among)].filter((id) => id !== "" && id !== medicineId);
  if (medicineId === "" || among.length === 0) return [];

  const result = await db.execute<Row>(sql`
    with want as (
      select l.salt_id from formulary_medicine_salts l where l.medicine_id = ${medicineId}
    ),
    src as (
      select m.id, coalesce(m.strength_label, '') as sl, m.form, m.route_class
        from formulary_medicines m
       where m.id = ${medicineId} and m.active
    )
    select c.id, c.brand_name, c.strength_label, c.form, c.route_class, c.schedule_flag
      from formulary_medicines c, src
     where c.id = any(${sql.param(among)}::text[])
       and c.id <> src.id
       and c.active
       and coalesce(c.strength_label, '') = src.sl
       and c.form = src.form
       and c.route_class = src.route_class
       and (select count(*) from want) > 0
       and (select count(*) from formulary_medicine_salts x where x.medicine_id = c.id)
           = (select count(*) from want)
       and not exists (
         select 1 from formulary_medicine_salts x
          where x.medicine_id = c.id
            and not exists (select 1 from want w where w.salt_id = x.salt_id)
       )
     order by c.brand_name asc, c.id asc
  `);

  return result.rows.map((r) => ({
    id: r.id,
    brandName: r.brand_name,
    strengthLabel: r.strength_label,
    form: r.form,
    routeClass: r.route_class,
    scheduleFlag: r.schedule_flag,
  }));
}

/**
 * May `toId` be dispensed in place of `fromId`?
 *
 * NOT A SECOND IMPLEMENTATION — it asks `equivalentMedicines` with a universe of one. A mutation to
 * any clause above therefore moves what the counter is OFFERED and what the gate ACCEPTS in the
 * same direction, which is the property the two hand-written copies never had.
 */
export async function isEquivalentMedicine(db: Db | Tx, fromId: string, toId: string): Promise<boolean> {
  return (await equivalentMedicines(db, fromId, { among: [toId] })).length === 1;
}
