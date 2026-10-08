import { sql } from "drizzle-orm";
import type { Db } from "../../kernel/db/client";
import { isReviewedComponent } from "./moiety";
import { searchMedicines } from "./search";
import type { MedicineHit } from "./search";

/**
 * ═══ THE MEDICINE SEARCH A PRESCRIBER TYPES INTO — THE CATALOGUE'S ANSWER, PLUS A LEARNED NICKNAME ═══
 *
 * Decisions 0051 and 0055; owner, 2026-10-08: "switch ON medicine nicknames."
 *
 * `searchMedicines` answers from the catalogue's own names. A doctor who types "pan forty" gets
 * nothing from it. When the OPD module has learned what that nickname means (`cds_aliases`, state
 * 'suggestion' or 'trusted'), this adds THAT ONE medicine to the answer, marked `alias`, so the
 * screen can say "nickname" beside the product's full name. Nothing is picked for the doctor.
 *
 *   trusted    — earned by doctors' own use: the first row.
 *   suggestion — two models agreed and the rules passed, nobody has used it yet: after the rows
 *                whose NAME starts with what was typed, before the rest.
 *
 * THE FORMULARY DOES NOT KNOW THE OPD MODULE. Nicknames are OPD's table and OPD's rules, and OPD
 * imports this module, not the other way round — so OPD REGISTERS its lookup here at module init
 * (`registerNicknameLookup`, the shape of `registerConsultStartGuard`). With nothing registered, or
 * with a lookup that answers null — which is what it answers whenever `ALIAS_PIPELINE_ENABLED` is
 * off — this function returns exactly what `searchMedicines` returned: the same rows, the same
 * order, no extra key on any of them.
 *
 * Only prescribing screens ask through here (the web consult and desk scribe with `for=rx`, the
 * phone consult's own route). The pharmacy's and the formulary office's searches do not.
 */
export type NicknameMark = {
  /** The nickname's own id — what a tap or a cross on this row is counted against. */
  id: string;
  state: "suggestion" | "trusted";
  /** A look-alike name exists: the screen asks for a second tap before taking the pick. */
  lasaGuard: boolean;
};
export type PrescribingHit = MedicineHit & { alias?: NicknameMark };

export type NicknameLookup = (db: Db, query: string) => Promise<{ medicineId: string; mark: NicknameMark } | null>;

let lookup: NicknameLookup | null = null;

/** Keyed by being the only one: a second registration REPLACES the first. Returns the un-register, for a suite. */
export function registerNicknameLookup(fn: NicknameLookup): () => void {
  lookup = fn;
  return () => { if (lookup === fn) lookup = null; };
}

/**
 * One catalogue row in the shape `searchMedicines` returns it — the same columns, the same reading
 * of the strength and of `reviewed`. Null for an unknown, inactive or uncomposed medicine: a row no
 * safety check can read is never offered (`search.ts`, "never offers a row the safety layer cannot read").
 */
export async function medicineHitById(db: Db, id: string): Promise<MedicineHit | null> {
  const res = await db.execute(sql`
    select m.id, m.brand_name, m.form, m.strength_label, m.code, m.route_class,
           (select array_agg(s.name order by s.name) from formulary_medicine_salts l join formulary_salts s on s.id = l.salt_id where l.medicine_id = m.id) as salts,
           not exists (select 1 from formulary_medicine_salts l join formulary_salts s on s.id = l.salt_id
                        where l.medicine_id = m.id and not ${isReviewedComponent(sql`s`)}) as reviewed
      from formulary_medicines m
     where m.id = ${id} and m.active
  `);
  const r = res.rows[0];
  if (r === undefined || !Array.isArray(r["salts"]) || r["salts"].length === 0) return null;
  return {
    id: String(r["id"]), name: String(r["brand_name"]), form: String(r["form"]),
    strength: r["strength_label"] === null ? null : String(r["strength_label"]).replace(/\/\s*$/, "").trim() || null,
    code: r["code"] === null ? null : String(r["code"]), routeClass: String(r["route_class"]),
    salts: (r["salts"] as unknown[]).map(String), prefix: false, reviewed: r["reviewed"] === true,
  };
}

export async function searchMedicinesForPrescribing(db: Db, query: string, limit = 10): Promise<PrescribingHit[]> {
  const hits: PrescribingHit[] = await searchMedicines(db, query, limit);
  if (lookup === null) return hits;
  const found = await lookup(db, query);
  if (found === null) return hits;

  const already = hits.findIndex((h) => h.id === found.medicineId);
  const base = already === -1 ? await medicineHitById(db, found.medicineId) : (hits[already] ?? null);
  if (base === null) return hits;
  const row: PrescribingHit = { ...base, alias: found.mark };
  const rest = hits.filter((h) => h.id !== found.medicineId);
  if (found.mark.state === "trusted") return [row, ...rest];
  /* After the names that START with what was typed; where the catalogue already ranked it higher, it keeps that place. */
  const exact = rest.findIndex((h) => !h.prefix);
  const at = exact === -1 ? rest.length : exact;
  const place = already === -1 ? at : Math.min(already, at);
  return [...rest.slice(0, place), row, ...rest.slice(place)];
}
