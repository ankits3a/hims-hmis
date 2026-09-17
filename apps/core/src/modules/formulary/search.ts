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

  /*
    ═══ A DOCTOR TYPES WHAT THEY MEAN, IN ANY ORDER: "para 500", "amox clav 625" ═══

    Until now this was ONE substring: `like '%para 500%'`. Measured against the real catalogue,
    `para 500` returned **0 rows** and `par 5` returned **0 rows**, because neither string appears
    anywhere in "Paracetamol 500 mg oral tablet" — the words are there, the phrase is not. A doctor
    who types the molecule and the strength, which is how a drug is said out loud, got nothing and
    had to guess what the field wanted instead.

    So the query is TOKENS, and every one of them must match — the AND a person means by typing two
    words.

    ═══ ONE TOKEN GETS THE INDEX: THE LONGEST ═══

    Only one predicate can drive the trigram index over 103,383 products, so the ANCHOR is the
    longest token — the one that narrows hardest — and it keeps the two indexed branches the
    UNION was built for (the comment below says why that union exists). The remaining tokens filter
    the rows that survive, which is cheap because the anchor has already cut the set.

    Length, not position: `500 para` and `para 500` are the same request, and a doctor who types
    the strength first should not fall off the index.

    ═══ THE OTHER TOKENS DO NOT SEE THE CODE, DELIBERATELY ═══

    Their haystack is the name, the strength and the form — NOT the catalogue code. `par 5` with the
    code included returned "Paracetamol 100 mg oral tablet" as its first row, because its code is
    `D9225` and that contains a `5`. A bare digit matching a catalogue code is noise dressed as a
    match. A doctor searching BY code types the whole code, which is then the longest token and is
    matched by the anchor branch, where codes belong.
  */
  const tokens = q.split(/\s+/).filter((t) => t !== "");
  const anchor = tokens.reduce((a, b) => (b.length > a.length ? b : a), tokens[0] ?? q);
  const rest: string[] = [];
  let anchorTaken = false;
  for (const t of tokens) {
    if (!anchorTaken && t === anchor) { anchorTaken = true; continue; }
    rest.push(t);
  }
  const like = `%${anchor}%`;
  const starts = `${anchor}%`;
  /*
    ═══ A WHOLE WORD BEATS AN ACCIDENT OF SPELLING ═══

    `ors` returned `Orsodic-SP` (diclofenac), `Orsofin-Plus` and `Orsimox CV` — brands that merely
    CONTAIN those three letters — while the actual oral rehydration salts sat below the fold.
    Measured, the cause was not the match but the RANKING: `Ors (glucose and potassium chloride
    and sodium chloride and sodium citrate)` starts with `ors` exactly as `Orsodic-SP` does, so the
    prefix test tied, and `salt_rank` then decided it — paracetamol's 4,866 products against the
    ORS salts' 126. The right drug lost to a bigger molecule's market share.

    So a match on a whole WORD outranks a match inside one, and it is placed above `salt_rank`
    because that is the tie it exists to break. `\m` and `\M` are Postgres's word boundaries.

    ═══ AND IT IS GATED, BECAUSE THE FIRST DRAFT OF IT BROKE `amox` ═══

    Placed unconditionally above `salt_rank`, this term put **Amoxapine** (an antidepressant, 14
    products) above **Amoxicillin** (3,830) for `amox` — because `Amox 50` carries the query as a
    WORD while `Amoxil` only starts with it. That is precisely the defect the ranking comment above
    was written to prevent, and the suite caught it.

    The two cases differ in one measurable way. `amox` is the beginning of a MOLECULE's name, so a
    doctor typing it means the molecule and market share is the right tie-break. `ors` is the
    beginning of no molecule in this formulary, so it can only be a product's name, and the word
    match is all there is to go on.

    So the term applies only when NO moiety name starts with the query. One boolean, computed once
    in the query itself.

    This is also why no abbreviation entry is needed for `ors`: the brand is in the release.
  */
  const word = `\\m${anchor.replace(/[.^$|()[\]{}*+?\\-]/g, "\\$&")}\\M`;
  /** Every remaining token must appear in the name, the strength or the form. */
  const restFilter = rest.length === 0
    ? sql`true`
    : sql.join(
      rest.map((t) => sql`lower(
        h.brand_name || ' ' || coalesce(h.strength_label, '') || ' ' || h.form
      ) like ${`%${t}%`}`),
      sql` and `,
    );

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
  /*
    ═══ A MOLECULE THE DOCTOR NAMED BEATS A BRAND THAT MERELY STARTS THE SAME WAY ═══

    Measured on the real catalogue: `met` returned "Methionine and paracetamol", "Metoclopramide
    and paracetamol", "Metacin (paracetamol)" and "Metalgin (paracetamol)" — four paracetamol
    products, and no metformin, metronidazole or metoprolol anywhere. 58 moieties begin with `met`,
    led by metformin hydrochloride's 1,272 products, but paracetamol's 4,866 let any brand merely
    SPELT met… outrank every one of them. The doctor named a molecule; the ranking answered with a
    brand coincidence.

    So a row whose own MOIETY begins with the query outranks one where only the label does, placed
    above `salt_rank` because market share is exactly what was drowning it.

    It is inert where it should be. For `amox` both amoxicillin and amoxapine qualify, so the tie
    falls through to `salt_rank` and S3 still holds. For `telma` and `ors` no moiety qualifies at
    all, so the brand ranking is untouched and S10 still holds.

    ═══ AND THEN THE SIMPLER PRODUCT WINS THE TIE ═══

    That alone was not enough. `met` then returned "Metoclopramide and paracetamol" combinations,
    which DO carry a met… moiety — and which inherit paracetamol's 4,866 through `salt_rank`, so
    they still buried pure metformin. A doctor who names one molecule is asking for that molecule,
    not for it packaged with another, so the row with FEWER moieties wins the tie before market
    share is consulted.

    This is the one idea worth taking from the other model's "purity shield", and it is worth
    taking narrowly: it is a TIE-BREAK under an explicit molecule match, not a blanket penalty on
    combinations. `amox clav 625` still reaches its two-moiety product, because both of its tokens
    have to match in the first place.
  */
  /*
    ═══ THE RELEASE'S BOILERPLATE IS NOT PART OF THE DRUG'S NAME ═══

    4,921 active products — 4.8% of the catalogue — are named "Product containing precisely
    amoxicillin 500 milligram and clavulanic acid …". The lead-in is the terminology's, not the
    drug's, and it starts with a P, so the prefix test could never fire for any of them however
    exactly a doctor typed the molecule.

    Measured: `amox clav` returned the 800 mg, the 250 mg, the 875 mg and seven more, and NOT ONE
    of the 1,787 rows carrying amoxicillin 500 + clavulanic acid 125 — the commonest strength
    dispensed in India, and the one the trade calls 625. They were not missing from the catalogue;
    they were behind a phrase nobody types.

    So the prefix and whole-word tests read the name with that lead-in removed. Nothing else is
    touched: the stored value, the displayed name and every other rank term are unchanged.
  */
  const res = await db.execute(sql`
    with intent as (
      select exists (
        select 1 from formulary_salts s where s.active and lower(s.name) like ${starts}
      ) as molecule
    ),
    hits as (
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
    scored as (
      /* A MOLECULE THE DOCTOR NAMED BEATS A BRAND THAT MERELY STARTS THE SAME WAY.
         Written above this query, not here: this is inside a tagged template, where a backtick in
         a comment closes the template -- the trap the header already records, walked into again. */
      select h.*,
             regexp_replace(lower(h.brand_name), '^product containing precisely ', '') as plain_name,
             (select count(*) from formulary_medicine_salts l where l.medicine_id = h.id) as salt_count,
             exists (
        select 1 from formulary_medicine_salts l join formulary_salts s on s.id = l.salt_id
         where l.medicine_id = h.id and lower(s.name) like ${starts}
      ) as moiety_prefix
        from hits h where ${restFilter}
    ),
    ranked as (
      select * from scored h
       order by (case when (select molecule from intent) then false
                       else plain_name ~ ${word} end) desc,
                (plain_name like ${starts}) desc,
                moiety_prefix desc,
                salt_count asc,
                salt_rank desc,
                (code is not null) desc,
                similarity(lower(brand_name), ${q}) desc,
                length(plain_name) asc,
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
     order by (case when (select molecule from intent) then false
                     else r.plain_name ~ ${word} end) desc,
              (r.plain_name like ${starts}) desc,
              r.moiety_prefix desc,
              r.salt_count asc,
              r.salt_rank desc,
              (r.code is not null) desc,
              length(r.plain_name) asc
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
