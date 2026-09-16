import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * ═══ WHAT MAKES A `formulary_salts` ROW A MOIETY: ONE PREDICATE, WRITTEN ONCE ═══
 *
 * A row is a MOIETY when a person has said so:
 *   - it is curated (`source_ref is null`): a pharmacist or the seed created it by name; or
 *   - it is a release image that some MAPPED substance points at: a pharmacist attested that this
 *     entry is the moiety.
 *
 * Every other row is a RELEASE IMAGE nobody has reviewed: the importer's verbatim copy of one
 * substance, which carries no drug class and no interaction pairs.
 *
 * ═══ WHY THE SECOND CLAUSE EXISTS: THE NAME IS ALREADY TAKEN ═══
 *
 * `formulary_salts_name_lower_ux` is unique on `lower(name)`, and the importer wrote `Paracetamol`
 * as a release image with 4,866 products (measured on `hmis_formulary_dev`). A curated
 * `paracetamol` therefore cannot be created, and the same is true for every base substance the
 * release names as itself, which is most of them. The image IS the moiety once a pharmacist says
 * so. Attesting "Paracetamol is its own moiety" moves no rows and renames nothing, and ruling it
 * otherwise later makes the row an unreviewed image again.
 *
 * ═══ WHY IT IS A FUNCTION AND NOT FOUR COPIES ═══
 *
 * The doctor's `reviewed` flag, the census's unreviewed count, the attestation's target check and
 * the moiety picker all ask this question. Four hand-written copies are four places for "reviewed"
 * to mean four things (this lane's recurring defect: `docs/.../2026-09-16-HANDOFF-formulary-lane.md`
 * §3). `salt` is the SQL alias the caller gave `formulary_salts`.
 */
export function isMoiety(salt: SQL): SQL {
  return sql`(${salt}.source_ref is null or exists (
    select 1 from formulary_substances rv
     where rv.salt_id = ${salt}.id and rv.mapping_status = 'mapped'))`;
}

/**
 * ═══ WHAT MAKES A COMPOSITION COMPONENT REVIEWED: A SECOND QUESTION, BUILT ON THE FIRST ═══
 *
 * A component is reviewed when it is a moiety (above), OR when it is the release entry of a
 * substance a pharmacist has MAPPED. For the second kind the decision is already made, and the
 * resolver names the moiety beside the entry wherever the entry is still named (`resolve.ts`,
 * `mappedMoieties`). So every check sees what it would see for the moiety itself. Those rows are
 * a hand-composed product, a product the projection could not move (E2, E3), or a text.
 *
 * It is not `isMoiety`, and it must not replace it: an attestation may not TARGET a mapped entry.
 * That entry is not the moiety; the moiety is.
 *
 * An UNMAPPABLE substance's entry stays unreviewed (E4): nothing stands beside it.
 *
 * The doctor's `reviewed` flag, the census's unreviewed count and the prescribing checks'
 * `unreviewedLineIndexes` ask this question, and they ask it here, so that the picker and the check
 * cannot disagree about one product.
 */
export function isReviewedComponent(salt: SQL): SQL {
  return sql`(${isMoiety(salt)} or exists (
    select 1 from formulary_substances rd
     where rd.sctid = ${salt}.source_ref and rd.mapping_status = 'mapped'))`;
}
