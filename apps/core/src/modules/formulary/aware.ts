import { and, eq, sql } from "drizzle-orm";
import { formularyMedicines } from "../../kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY STAGE D5 — THE WHO AWaRe CLASSIFICATION OF ANTIBIOTICS, AS THIS CATALOGUE NAMES THEM ═══
 *
 * SOURCE: World Health Organization. *The WHO AWaRe (Access, Watch, Reserve) antibiotic book / AWaRe classification
 * of antibiotics for evaluation and monitoring of use, 2023.* Geneva: WHO; 2023 (WHO/MHP/HPS/EML/2023.04).
 * Licence: CC BY-NC-SA 3.0 IGO. The classification is WHO's; the entries below are transcribed by moiety set and
 * route, in the catalogue's own moiety names (`formulary_salts.name`, lower case, `+` between the moieties of a
 * combination, alphabetical).
 *
 * WHAT IS HERE AND WHAT IS NOT. Only entries the transcriber was confident of. A moiety set not listed stays null
 * and is a pharmacist's to classify at `/formulary/admin`; nothing is guessed. The Indian market's many irrational
 * fixed-dose combinations (cefixime + ofloxacin, …) are deliberately absent: WHO lists them as "not recommended",
 * which is not an AWaRe class, and the prescribing check is where they are met.
 *
 * ROUTE. AWaRe classifies some moieties by route: fosfomycin and minocycline are Reserve IV and Watch oral; colistin
 * and polymyxin B are Reserve as systemic (IV) agents. `route` says which products an entry reaches:
 *   `parenteral` — a form naming an injection or an infusion; `oral` — a tablet, capsule, suspension, syrup, sachet or
 *   granules; `any` — every systemic product of the moiety set. Topical products (`route_class = topical`) are never
 *   classified: AWaRe is about systemic use.
 *
 * RESTRICTED (DECIDED 2026-09-28, stage D doc): every Reserve entry starts restricted, and so do the four
 * carbapenems (Watch in AWaRe) — common Indian hospital AMSP policy, and the knowledge bundle's AMSP rules already
 * flag meropenem. The hospital may restrict more at `/formulary/admin`.
 */
export type AwareCategory = "Access" | "Watch" | "Reserve";
export const AWARE_CATEGORIES: readonly AwareCategory[] = ["Access", "Watch", "Reserve"];
export type AwareRoute = "any" | "parenteral" | "oral";
export type AwareEntry = { moieties: string; route: AwareRoute; category: AwareCategory; restricted: boolean };

export const AWARE_SOURCE = "WHO AWaRe classification of antibiotics 2023 (WHO/MHP/HPS/EML/2023.04)";

const access = (moieties: string, route: AwareRoute = "any"): AwareEntry => ({ moieties, route, category: "Access", restricted: false });
const watch = (moieties: string, route: AwareRoute = "any"): AwareEntry => ({ moieties, route, category: "Watch", restricted: false });
/** A carbapenem: Watch in AWaRe, restricted by this hospital's policy (DECIDED). */
const carbapenem = (moieties: string): AwareEntry => ({ moieties, route: "any", category: "Watch", restricted: true });
const reserve = (moieties: string, route: AwareRoute = "any"): AwareEntry => ({ moieties, route, category: "Reserve", restricted: true });

export const AWARE_LIST: readonly AwareEntry[] = [
  // ── ACCESS ──
  access("amikacin"), access("amoxicillin"), access("amoxicillin+clavulanic acid"), access("ampicillin"),
  access("ampicillin+sulbactam"), access("benzylpenicillin"), access("procaine benzylpenicillin"),
  access("phenoxymethylpenicillin"), access("cloxacillin"), access("dicloxacillin"), access("flucloxacillin"),
  access("cefalexin"), access("cefazolin"), access("cefadroxil"), access("chloramphenicol"), access("clindamycin"),
  access("doxycycline"), access("gentamicin"), access("metronidazole"), access("nitrofurantoin"),
  access("pivmecillinam"), access("sulfamethoxazole+trimethoprim"), access("tetracycline"),
  // ── WATCH ──
  watch("azithromycin"), watch("clarithromycin"), watch("erythromycin"), watch("roxithromycin"),
  watch("ciprofloxacin"), watch("levofloxacin"), watch("moxifloxacin"), watch("norfloxacin"), watch("ofloxacin"),
  watch("cefaclor"), watch("cefdinir"), watch("cefditoren"), watch("cefixime"), watch("cefoperazone+sulbactam"),
  watch("cefotaxime"), watch("cefoxitin"), watch("cefpodoxime"), watch("cefprozil"), watch("ceftazidime"),
  watch("ceftriaxone"), watch("cefuroxime"), watch("cefepime"), watch("piperacillin+tazobactam"),
  watch("teicoplanin"), watch("vancomycin"), watch("tobramycin"),
  watch("fosfomycin", "oral"), watch("minocycline", "oral"),
  // ── WATCH, AND RESTRICTED HERE: THE CARBAPENEMS ──
  carbapenem("meropenem"), carbapenem("cilastatin+imipenem"), carbapenem("ertapenem"), carbapenem("doripenem"),
  // ── RESERVE ──
  reserve("colistimethate", "parenteral"), reserve("colistin", "parenteral"), reserve("polymyxin b", "parenteral"),
  reserve("fosfomycin", "parenteral"), reserve("minocycline", "parenteral"),
  reserve("tigecycline"), reserve("linezolid"), reserve("tedizolid"), reserve("tedizolid phosphate"),
  reserve("daptomycin"), reserve("dalbavancin"), reserve("telavancin"), reserve("oritavancin"),
  reserve("avibactam+ceftazidime"), reserve("meropenem+vaborbactam"), reserve("cilastatin+imipenem+relebactam"),
  reserve("ceftolozane+tazobactam"), reserve("cefiderocol"), reserve("aztreonam"), reserve("eravacycline"),
  reserve("omadacycline"), reserve("plazomicin"), reserve("lefamulin"), reserve("faropenem"),
  reserve("ceftobiprole"), reserve("ceftaroline fosamil"), reserve("iclaprim"), reserve("durlobactam+sulbactam"),
];

const PARENTERAL = "(inject|infusion|intravenous|intramuscular)";
const ORAL = "(tablet|capsule|oral|suspension|syrup|sachet|granule)";

export type AwareClassificationReport = {
  source: string;
  /** Listed moieties the catalogue carries under that name (each counted once). */
  moietiesInCatalogue: string[];
  /** Products classified on THIS run (their class was null), by class; and how many of them were made restricted. */
  classified: { Access: number; Watch: number; Reserve: number };
  restricted: number;
};

/**
 * Fills `aware_category` (and raises `antimicrobial_restricted`) on every systemic product whose moiety set and form
 * match an entry, WHERE ITS CLASS IS STILL NULL — so a value a pharmacist set is never overwritten, and a second run
 * changes nothing. The restricted flag is only ever raised (`or`), never lowered. `updated_by` names the seed.
 */
export async function classifyAwareMedicines(tx: Tx, actor: Actor): Promise<AwareClassificationReport> {
  const list = sql.join(AWARE_LIST.map((e) => sql`(${e.moieties}, ${e.route}, ${e.category}, ${e.restricted})`), sql`, `);
  const rows = await tx.execute<{ category: AwareCategory; restricted: boolean }>(sql`
    with sets as (
      select m.id, m.form, string_agg(lower(s.name), '+' order by lower(s.name)) as moieties
        from formulary_medicines m
        join formulary_medicine_salts ms on ms.medicine_id = m.id
        join formulary_salts s on s.id = ms.salt_id
       where m.route_class = 'systemic' and m.aware_category is null
       group by m.id, m.form
    ), list(moieties, route, category, restricted) as (values ${list})
    update formulary_medicines m
       set aware_category = l.category,
           antimicrobial_restricted = m.antimicrobial_restricted or l.restricted::boolean,
           updated_by = ${actor.id}, updated_at = now()
      from sets, list l
     where m.id = sets.id and sets.moieties = l.moieties
       and (l.route = 'any'
         or (l.route = 'parenteral' and sets.form ~* ${PARENTERAL})
         or (l.route = 'oral' and sets.form ~* ${ORAL} and sets.form !~* ${PARENTERAL}))
    returning l.category as category, m.antimicrobial_restricted as restricted`);
  const classified = { Access: 0, Watch: 0, Reserve: 0 };
  let restricted = 0;
  for (const r of rows.rows) {
    classified[r.category] += 1;
    if (r.restricted) restricted += 1;
  }
  const names = [...new Set(AWARE_LIST.flatMap((e) => e.moieties.split("+")))];
  const found = await tx.execute<{ name: string }>(sql`
    select distinct lower(name) as name from formulary_salts
     where lower(name) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
  return { source: AWARE_SOURCE, moietiesInCatalogue: found.rows.map((r) => r.name).sort(), classified, restricted };
}

/** STAGE D5 — does any ACTIVE product need the steward? (The office's "no steward appointed" row is red only then.) */
export async function restrictedAntimicrobialExists(db: Db | Tx): Promise<boolean> {
  const rows = await db.select({ id: formularyMedicines.id }).from(formularyMedicines)
    .where(and(eq(formularyMedicines.antimicrobialRestricted, true), eq(formularyMedicines.active, true))).limit(1);
  return rows.length > 0;
}
