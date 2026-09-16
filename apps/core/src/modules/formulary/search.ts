import { sql } from "drizzle-orm";
import { isReviewedComponent } from "./moiety";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE DRUG TYPEAHEAD — WHAT THE DOCTOR SEES AFTER THREE LETTERS ═══
 *
 * Owner, 2026-09-14: *"even though the doctor doesn't enable AI suggestion in the prescription tab,
 * auto complete will work if doctor starts to type drug name."* So this is the always-on half: no
 * model, no patient, no co-pilot switch — the hospital's own catalogue, matched on what was typed.
 *
 * ═══ IT REPLACED A `<select>` THAT WOULD HAVE SHIPPED THE WHOLE CATALOGUE ═══
 *
 * The screen used to load EVERY medicine into a dropdown. That was tolerable against a handful of
 * curated rows and became impossible the moment the owner's catalogue landed: 103,383 options on
 * every consult screen load. This comment used to say "a 15 MB payload, measured"; no field subset
 * reproduces that figure. The measured sizes are 57.3 MiB for the full rows and 37.0 MiB trimmed to
 * what the screen used, and the method is written beside the `medicines/search` route in
 * `formulary.controller.ts`. A typeahead is not a nicety here: it is what makes a catalogue this
 * size usable at all.
 *
 * ═══ HOW IT RANKS, AND WHY THE SALT IS IN THE `WHERE` ═══
 *
 * A doctor types `par` meaning a name that STARTS with it, so prefix matches come first. They also
 * type `clav` meaning Augmentin — a moiety, not a brand — so the join reaches the composition and
 * a salt match qualifies a row. Within each band, trigram similarity orders and the shorter name
 * wins ties: `Paracetamol Tablets IP 500mg` before `Paracetamol + Caffeine + Domperidone …`.
 *
 * `lower(brand_name) gin_trgm_ops` (migration 0085) is what keeps the anywhere-match off a
 * sequential scan of a hundred thousand rows on every keystroke.
 *
 * ═══ AND IT NEVER OFFERS A ROW THE SAFETY LAYER CANNOT READ ═══
 *
 * Both branches require a composition. The moiety branch did so already, by construction; the
 * brand-name branch did not, and could hand back one of the eight uncomposed rows. Picking one set
 * a `medicineId` that `getCoverage` counts as resolved while no check can fire on it — the exact
 * failure #186 refused to set the id for. The filter answers that instead of arguing with it.
 */
export type MedicineHit = {
  id: string;
  name: string;
  form: string;
  strength: string | null;
  /** The hospital's own catalogue code — `D0230`. Null on a branded row; only generics carry one. */
  code: string | null;
  routeClass: string;
  /**
   * The moieties, for the line under the name — and NEVER empty, because a row with no moiety is
   * not offered at all (`search.test.ts` S1). That is what lets the screen fill `medicineId` on a
   * pick: every id this route hands out is one the interaction, duplicate and allergy checks can
   * reason about. Measured on the imported catalogue, 8 of 103,383 active medicines are uncomposed.
   */
  salts: string[];
  /** True when the name itself starts with what was typed — the screen bolds that prefix. */
  prefix: boolean;
  /**
   * TRUE WHEN EVERY COMPONENT IS A MOIETY (phase 2, W9: `moiety.ts` says what that means, once).
   * False when at least one is still a release entry nobody has reviewed. Such a component carries no drug class
   * and no interaction pairs, so an allergy to "penicillins" or a warfarin interaction cannot fire
   * on it. The screen says so beside the name rather than letting the pick look as checked as any
   * other.
   *
   * Named `reviewed`, not `checked`: a curated moiety with no class and no pairs is reviewed, but
   * nothing has been checked against it either. The word claims only what is true.
   */
  reviewed: boolean;
};

export async function searchMedicines(db: Db, query: string, limit = 10): Promise<MedicineHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const capped = Math.min(Math.max(limit, 1), 25);
  const like = `%${q}%`;
  const starts = `${q}%`;

  /*
    ═══ THE MOIETY IS THE STRONGER SIGNAL, AND THE FIRST DRAFT PROVED IT ═══

    (Written here rather than inside the query below: a backtick in a comment INSIDE a tagged
    template literal closes the template. The compiler caught it; nothing else would have.)

    THE MOIETY THE MARKET IS BUILT AROUND OUTRANKS THE REST. Ranking "amox" on trigram similarity
    alone put Amoxapine — an antidepressant with 14 products — above Amoxicillin with 3,830,
    because the shorter word scores higher. A doctor typing three letters means the molecule the
    market is built around, so product_count (set by the catalogue import) breaks that tie.
    Computing it per keystroke instead costs two seconds over 142,759 composition rows: measured.

    Ranking on the NAME alone put `Parcar (cabergoline)` above paracetamol for `par` — it is shorter
    and trigram-similar — and `clav` never reached amoxicillin-clavulanate at all, because ten
    brands whose names merely begin "Clav" filled every slot. Both measured against the real
    catalogue, which is the only place a ranking can be judged.

    A doctor typing three letters is naming a MOLECULE far more often than a brand, so a row whose
    SALT starts with the query outranks one where only the label does; a generic (it carries a
    D-code) outranks a branded repackaging of the same molecule; and only then do similarity and
    brevity break ties.
  */
  /*
    ═══ TWO INDEXED BRANCHES, UNIONED — NOT ONE `OR` ═══

    The first draft matched the name OR the moiety in one predicate, and the plan showed what that
    costs: Postgres cannot use the trigram index for one arm of an OR whose other arm is a
    correlated EXISTS, so it sequentially scanned all 103,383 products (240 ms) and then all 142,759
    compositions inside the join. A UNION lets each branch take its own index, and the composition
    lookup now rides `formulary_medicine_salts_salt_idx`.

    The moiety names are resolved only for the rows that SURVIVE the limit — ten array_aggs instead
    of several thousand, which was the other half of the 575 ms.
  */
  const res = await db.execute(sql`
    with hits as (
      select m.id, m.brand_name, m.form, m.strength_label, m.code, m.route_class, m.salt_rank
        from formulary_medicines m
       where m.active
         and (lower(m.brand_name) like ${like} or lower(coalesce(m.code, '')) like ${starts})
         and exists (select 1 from formulary_medicine_salts l where l.medicine_id = m.id)
      union
      select m.id, m.brand_name, m.form, m.strength_label, m.code, m.route_class, m.salt_rank
        from formulary_medicines m
       where m.active
         and exists (
           select 1 from formulary_medicine_salts l
             join formulary_salts s on s.id = l.salt_id
            where l.medicine_id = m.id and lower(s.name) like ${like}
         )
    ),
    ranked as (
      select * from hits
       order by (lower(brand_name) like ${starts}) desc,
                salt_rank desc,
                (code is not null) desc,
                similarity(lower(brand_name), ${q}) desc,
                length(brand_name) asc,
                brand_name asc
       limit ${capped}
    )
    select r.*,
           coalesce(
             (select array_agg(s.name order by s.name)
                from formulary_medicine_salts l join formulary_salts s on s.id = l.salt_id
               where l.medicine_id = r.id),
             '{}'
           ) as salts,
           (lower(r.brand_name) like ${starts}) as prefix,
           not exists (select 1 from formulary_medicine_salts l join formulary_salts s on s.id = l.salt_id
                        where l.medicine_id = r.id and not ${isReviewedComponent(sql`s`)}) as reviewed
      from ranked r
     order by (lower(r.brand_name) like ${starts}) desc,
              r.salt_rank desc,
              (r.code is not null) desc,
              length(r.brand_name) asc
  `);

  return res.rows.map((r) => ({
    id: String(r["id"]),
    name: String(r["brand_name"]),
    form: String(r["form"]),
    /* `10 mg/` is how 70,980 rows arrive — a denominator the bundle never filled in. The trailing
       slash is noise on a doctor's screen, and stripping it here keeps the stored value untouched. */
    strength: r["strength_label"] === null ? null : String(r["strength_label"]).replace(/\/\s*$/, "").trim() || null,
    code: r["code"] === null ? null : String(r["code"]),
    routeClass: String(r["route_class"]),
    salts: Array.isArray(r["salts"]) ? (r["salts"] as unknown[]).map(String) : [],
    prefix: r["prefix"] === true,
    reviewed: r["reviewed"] === true,
  }));
}
