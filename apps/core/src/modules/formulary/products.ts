import { sql } from "drizzle-orm";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ A COMPOSITION → THE CATALOGUE PRODUCT TO PRESCRIBE (the CDS regimen fill, 2026-09-23) ═══
 *
 * Production, prescription 01M36QQXMD7DKKHZ7MF2ZC1N8W: a doctor filled the URI regimen and issued
 * four lines of free text with no `medicineId`. `resolveDrugTexts` is EXACT by design (DD2), so
 * "Amoxicillin and Clavulanic Acid 625mg" resolves to nothing — and every check at issue that keys
 * on a resolution (the moiety and class allergy paths, interactions, duplicates, drug-disease) had
 * nothing to reason about. The counter could not tell which product was meant either.
 *
 * The regimen knows what it means: a SET of moieties, each at a strength, in a dose form. This is
 * the one place that turns that into a product, and it is deliberately NOT fuzzy — it is DD2's
 * "exact" half applied to a composition instead of a name.
 *
 * ═══ THE RULE ═══
 *
 *   1. SALTS — the medicine's composition is EXACTLY the spec's moiety set: no fewer (a missing
 *      clavulanate is a different drug), no more (paracetamol + pentazocine is not paracetamol).
 *      Moiety names resolve to active salts by name, then alias.
 *   2. FORM — the dose form's class (tablet / chewable / dispersible / capsule / oral liquid /
 *      sachet / topical / inhaler) and its release (conventional vs modified) both equal the spec's.
 *   3. STRENGTH — the medicine's `strength_label` must parse, and equal one component's strength
 *      (the catalogue stores the FIRST component's strength there, in the bundle's own order, which
 *      is not the regimen's order). A combination's other components are checked against the
 *      strengths the NAME carries whenever the name carries any (every generic row does: "Amoxicillin
 *      500 mg and clavulanic acid … 125 mg oral tablet"); a brand name carries none. A label that
 *      does not parse is NOT a match: a strength nobody can read is not a strength that agrees.
 *   4. TIER — a product this hospital STOCKS (the caller's `stockedIds`) first; else a GENERIC
 *      (a catalogue clinical drug — it carries a D-code). A brand the hospital does not stock is
 *      never chosen: that would be the server picking a manufacturer for the doctor.
 *   5. TIE-BREAK — shortest name, then name, then id. Stable, so the same regimen fills the same
 *      product on every call. Several stocked products that all pass 1–3 are the same medicine
 *      by composition, strength and form; which one is on the counter is the pharmacy's to swap.
 *
 * No match is `null`, and the caller shows it as a free-text line the doctor must pick — never a
 * nearest guess, because a wrong product attaches another drug's moieties to the line and every
 * check downstream then reasons confidently about a medicine the patient is not getting.
 */

export type FormClass =
  | "tablet" | "chewable_tablet" | "dispersible_tablet" | "capsule" | "oral_liquid" | "sachet" | "topical" | "inhaler";

export type ProductSpec = {
  /** Every moiety and its strength. `perMl` set means the strength is a concentration: `mg` per `perMl` mL. */
  components: { moiety: string; mg: number; perMl?: number }[];
  form: FormClass;
  /** Modified (SR/ER/prolonged) release. Absent means conventional. */
  modifiedRelease?: boolean;
};

export type ProductMatch = {
  medicineId: string;
  name: string;
  form: string;
  strength: string | null;
  code: string | null;
  /** True when the product came from the caller's stocked set (tier 1). */
  stocked: boolean;
};

/** Beyond this many specs in one call the caller is not filling one regimen. */
export const MAX_PRODUCT_SPECS = 50;

export function formClassOf(form: string): FormClass | null {
  const f = form.toLowerCase();
  if (/inhal|aerosol|rotacap|nebul/.test(f)) return "inhaler";
  if (/chewable/.test(f)) return "chewable_tablet";
  if (/dispersible|tablet for (?:\w+ )*suspension|orodispersible/.test(f)) return "dispersible_tablet";
  if (/tablet|\btab\b/.test(f)) return "tablet";
  if (/capsule|\bcap\b/.test(f)) return "capsule";
  if (/\bgel\b|cream|ointment|lotion|cutaneous|topical/.test(f)) return "topical";
  if (/oral (?:suspension|solution|syrup|drops|liquid|emulsion)|syrup|elixir|powder for oral (?:suspension|solution|syrup)|^suspension$|^solution$/.test(f)) {
    return "oral_liquid";
  }
  if (/sachet|granules|oral powder/.test(f)) return "sachet";
  return null;
}

export function isModifiedRelease(form: string): boolean {
  return /prolonged|sustained|extended|modified|controlled|\bsr\b|\ber\b|\bcr\b/.test(form.toLowerCase());
}

type Amount = { mg: number; perMl: number | null };

const MASS_UNIT: Record<string, number> = {
  mg: 1, milligram: 1, milligrams: 1, g: 1000, gram: 1000, grams: 1000,
  mcg: 0.001, microgram: 0.001, micrograms: 0.001, "µg": 0.001,
};

/** A strength label as the catalogue writes it: `650 mg/`, `1 g/`, `200/5 mg/ml`, `40 mg/ml`, `500 mg/Vial`, `650 mg`. */
export function parseStrengthLabel(label: string | null): Amount | null {
  if (label === null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*(mg|g|mcg|microgram|µg)\b\s*(?:\/\s*(ml)\b)?/i.exec(label);
  if (m === null) return null;
  const scale = MASS_UNIT[m[3]!.toLowerCase()];
  if (scale === undefined) return null;
  const mg = Number(m[1]) * scale;
  if (m[4] === undefined) return { mg, perMl: null };
  return { mg, perMl: m[2] === undefined ? 1 : Number(m[2]) };
}

/** Every strength a product NAME carries: `500 mg`, `125 milligram`, `250 mg/5 mL`, `30 milligram/5 milliliter`. */
export function amountsInName(name: string): Amount[] {
  const out: Amount[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(mg|milligrams?|g|grams?|mcg|micrograms?|µg)\b(?:\s*\/\s*(?:(\d+(?:\.\d+)?)\s*)?(ml|milliliters?|millilitres?)\b)?/gi;
  for (const m of name.matchAll(re)) {
    const scale = MASS_UNIT[m[2]!.toLowerCase()];
    if (scale === undefined) continue;
    out.push({ mg: Number(m[1]) * scale, perMl: m[4] === undefined ? null : (m[3] === undefined ? 1 : Number(m[3])) });
  }
  return out;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/** Same kind (a mass or a concentration) and the same value — `250 mg/5 mL` equals `50 mg/mL`. */
export function sameAmount(a: Amount, b: Amount): boolean {
  if ((a.perMl === null) !== (b.perMl === null)) return false;
  if (a.perMl === null || b.perMl === null) return close(a.mg, b.mg);
  return close(a.mg / a.perMl, b.mg / b.perMl);
}

type Candidate = {
  id: string; name: string; form: string; strength: string | null; code: string | null; saltIds: string[];
};

function specAmount(c: ProductSpec["components"][number]): Amount {
  return { mg: c.mg, perMl: c.perMl ?? null };
}

export function strengthAgrees(spec: ProductSpec, name: string, strengthLabel: string | null): boolean {
  const label = parseStrengthLabel(strengthLabel);
  if (label === null) return false;
  const wanted = spec.components.map(specAmount);
  if (!wanted.some((w) => sameAmount(w, label))) return false;
  if (wanted.length === 1) return true;
  const named = amountsInName(name);
  if (named.length === 0) return true;
  return wanted.every((w) => named.some((n) => sameAmount(w, n)));
}

function formAgrees(spec: ProductSpec, form: string): boolean {
  return formClassOf(form) === spec.form && isModifiedRelease(form) === (spec.modifiedRelease === true);
}

const byTieBreak = (a: Candidate, b: Candidate): number =>
  a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1);

/**
 * One product per spec, or null. `stockedIds` is what the hospital's counter can sell; it is a
 * shelf-sized list (hundreds), and the read below touches only medicines that contain the spec's
 * first moiety, through `formulary_medicine_salts_salt_idx`.
 */
export async function matchProducts(
  db: Db | Tx, specs: readonly (ProductSpec | null)[], stockedIds: readonly string[],
): Promise<(ProductMatch | null)[]> {
  if (specs.length > MAX_PRODUCT_SPECS) throw new Error(`matchProducts: ${String(specs.length)} specs > ${String(MAX_PRODUCT_SPECS)}`);
  const names = [...new Set(specs.flatMap((s) => s?.components.map((c) => c.moiety.trim().toLowerCase()) ?? []))];
  if (names.length === 0) return specs.map(() => null);

  /* Name first, then alias — the same precedence `resolveDrugTexts` gives a moiety. */
  const saltRows = await db.execute<{ id: string; name: string; aliases: string[] | null }>(sql`
    select id, name, aliases from formulary_salts
     where active
       and (lower(name) = any(${sql.param(names)}::text[])
            or exists (select 1 from jsonb_array_elements_text(aliases) a where lower(a) = any(${sql.param(names)}::text[])))
  `);
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string>();
  for (const r of saltRows.rows) {
    byName.set(r.name.toLowerCase(), r.id);
    for (const a of r.aliases ?? []) if (!byAlias.has(a.toLowerCase())) byAlias.set(a.toLowerCase(), r.id);
  }
  const saltOf = (moiety: string): string | undefined => {
    const k = moiety.trim().toLowerCase();
    return byName.get(k) ?? byAlias.get(k);
  };

  const stocked = new Set(stockedIds);
  const out: (ProductMatch | null)[] = [];
  for (const spec of specs) {
    if (spec === null || spec.components.length === 0) { out.push(null); continue; }
    const wanted = spec.components.map((c) => saltOf(c.moiety));
    if (wanted.some((id) => id === undefined)) { out.push(null); continue; }
    const want = [...new Set(wanted as string[])].sort();

    const res = await db.execute<{
      id: string; brand_name: string; form: string; strength_label: string | null; code: string | null; salt_ids: string[];
    }>(sql`
      select m.id, m.brand_name, m.form, m.strength_label, m.code,
             array_agg(distinct ms.salt_id order by ms.salt_id) as salt_ids
        from formulary_medicines m
        join formulary_medicine_salts ms on ms.medicine_id = m.id
       where m.active
         and m.id in (select medicine_id from formulary_medicine_salts where salt_id = ${want[0]!})
         and (m.id = any(${sql.param([...stocked])}::text[]) or m.code is not null)
       group by m.id
    `);
    const candidates: Candidate[] = res.rows
      .map((r) => ({ id: r.id, name: r.brand_name, form: r.form, strength: r.strength_label, code: r.code, saltIds: [...r.salt_ids].sort() }))
      .filter((c) => c.saltIds.length === want.length && c.saltIds.every((id, i) => id === want[i]))
      .filter((c) => formAgrees(spec, c.form) && strengthAgrees(spec, c.name, c.strength));

    const onShelf = candidates.filter((c) => stocked.has(c.id)).sort(byTieBreak);
    const generic = candidates.filter((c) => c.code !== null).sort(byTieBreak);
    const pick = onShelf[0] ?? generic[0];
    out.push(pick === undefined ? null : {
      medicineId: pick.id, name: pick.name, form: pick.form, strength: pick.strength, code: pick.code,
      stocked: stocked.has(pick.id),
    });
  }
  return out;
}
