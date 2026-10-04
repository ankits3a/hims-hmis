import { sql } from "drizzle-orm";
import { amountsInName, formClassOf, isModifiedRelease, parseStrengthLabel, sameAmount } from "./products";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ A BRAND THE CATALOGUE HAS NEVER HEARD OF → THE CATALOGUE DRUG IT IS A COPY OF (owner 2026-10-04) ═══
 *
 * A hospital buys from small marketers (PCD and "hospital supply" brands: Hauz Pharma's SAZOTEL-40, ZUFIX-200,
 * SEYTRI-S 1.5GM). Measured on the Aptus Drugs quotation against the national catalogue: 151 of its 206 brands
 * are not in it, so the price-list import could only say "add it by hand" — 151 times.
 *
 * But every such brand IS a molecule the catalogue knows: SAZOTEL-40 is telmisartan 40 mg oral tablet. The
 * vendor's COMPOSITION column says so. This file reads that column and finds a catalogue medicine with the
 * same composition, strength and form — the TEMPLATE — so the vendor's brand can be added to the catalogue
 * carrying the template's salts, schedule and route. Every clinical check downstream (allergy classes,
 * interactions, duplicates, H1/X registers) then knows what the new brand is.
 *
 * ═══ WHY IT IS STRICT ═══
 *
 * A wrong template attaches another drug's moieties to a brand, and every check then reasons confidently
 * about a medicine the patient is not getting. So, like `matchProducts`:
 *   · the moieties must be EXACTLY the vendor's set (no fewer, no more), each moiety a family of salts
 *     ("cefixime" ⊇ cefixime trihydrate; "clavulanate" ⊇ clavulanate potassium, clavulanic acid);
 *   · every strength the vendor wrote must appear in the template (`250 mg/5 ml` = `50 mg/ml`); a component
 *     the vendor gave no strength for is not a match — a strength nobody wrote is not a strength that agrees;
 *   · the form class must agree (a cream is never a tablet) and so must modified release;
 *   · more than six moieties is a nutraceutical blend, not a drug to template: no answer.
 * No match is `null`, and the screen says "add it by hand". The person still confirms every twin.
 */

type Amount = { mg: number; perMl: number | null };
export type TwinForm =
  | "tablet" | "capsule" | "solid" | "oral_liquid" | "injection" | "eye_drop" | "ear_drop" | "nasal"
  | "topical" | "inhalation" | "sachet" | "vaginal" | "oromucosal";
export type TwinComponent = { moiety: string; amount: Amount | null; raw: string | null };
export type TwinSpec = { components: TwinComponent[]; form: TwinForm; modifiedRelease: boolean };
export type CompositionTwin = {
  medicineId: string; name: string; form: string; strength: string | null; schedule: string | null;
  routeClass: string; generic: boolean; salts: string[];
  /** Other catalogue medicines agree too, in a different SALT or kind of injection: the person must choose. */
  ambiguous: boolean;
  /** One of each of those others — the choices the screen offers beside this one. */
  others: Omit<CompositionTwin, "ambiguous" | "others">[];
};

const MAX_COMPONENTS = 6;

/** Vendor spellings → the catalogue's. Each one met on a real Indian price list. */
const SPELLING: [RegExp, string][] = [
  [/\bamoxycillin\b/g, "amoxicillin"], [/\bsulphate\b/g, "sulfate"], [/\bhcl\b/g, "hydrochloride"], [/\bpcm\b/g, "paracetamol"],
  [/\bclavu\w*nate\b/g, "clavulanate"], [/\bsulbactum\b/g, "sulbactam"], [/\bcalcitrol\b/g, "calcitriol"],
  [/\bvit(?:amin)?\.? ?d3\b/g, "colecalciferol"], [/\bcholecalciferol\b/g, "colecalciferol"], [/\bmethyl ?cobalamin\b/g, "methylcobalamin"], [/\bglimepride\b/g, "glimepiride"],
  [/\bivermectine\b/g, "ivermectin"], [/\bmeropenam\b/g, "meropenem"], [/\bpovidine\b/g, "povidone"], [/\bmefenemic\b/g, "mefenamic"],
  [/\b(?:clinidipine|clindipine|cilnidipne)\b/g, "cilnidipine"], [/\bthyroxine\b/g, "levothyroxine"], [/\bdocanoate\b/g, "decanoate"],
  [/\btrometgamine\b/g, "trometamol"], [/\bguaiphe\w*sin\b/g, "guaifenesin"], [/\bdiastage\b/g, "diastase"], [/\bcynocobalamin\b/g, "cyanocobalamin"],
  [/\bsulbactum\b/g, "sulbactam"], [/\bitroglycerine\b/g, "nitroglycerin"], [/\bnitroglycerine\b/g, "nitroglycerin"], [/\bsalbutamol\b/g, "salbutamol"],
  [/\bazithro\b/g, "azithromycin"], [/\bferric carboxy ?maltose\b/g, "ferric carboxymaltose"],
];
/** Words that describe the product, not the moiety. */
const NOISE = /\b(?:tablets?|tab|capsules?|cap|injection|inj|syrup|syp|susp(?:ension)?|sus|solution|sol|ophthalmic|opthalmic|infusion|concentrate|diluted|sterile|cream|gel|gargle|drops?|sugar free|with(?:out)? water|i\.?p\.?|b\.?p\.?|u\.?s\.?p\.?|sustained release|modified ?release|controlled release|extended release|prolonged release|s\.?r\.?|e\.?r\.?|x\.?l\.?|m\.?r\.?)(?=\W|$)/g;

/** `TELMISARTAN 40 mg & HYDROCHLOROTHIAZIDE 12.5` → two components, each a moiety and an amount. */
export function parseComposition(text: string): TwinComponent[] | null {
  let t = ` ${text.toLowerCase()} `;
  t = t.replace(/\([^)]*\)/g, " ").replace(/(\d),(\d)/g, "$1$2").replace(/eq\.?\s*to\b[^+&,]*/g, " ")
    .replace(/\bwith(?:out)? water\b|\bsugar free\b|\b(?:dry )?syrup\b|\bsuspension\b|\binhalation\b/g, " ");
  for (const [re, to] of SPELLING) t = t.replace(re, to);
  const parts = t.split(/\s*(?:\+|&|,|;|\band\b|\bwith\b)\s*/).map((p) => p.trim()).filter((p) => p !== "");
  const out: TwinComponent[] = [];
  for (const p of parts) {
    const m = /^(.*?)\s*(\d+(?:\.\d+)?)\s*(mg|mcg|µg|gm|g|i\.?u\.?|lac i\.?u\.?|%)?(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*ml\b)?/.exec(p);
    const name = (m === null ? p : m[1]!).replace(NOISE, " ").replace(/[^a-z0-9 -]/g, " ").replace(/\s+/g, " ").trim();
    if (!/[a-z]{3}/.test(name)) {
      // "…METFORMIN 500 / MG" — a bare strength belongs to the moiety before it.
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.amount === null && m !== null) { const a = amountOf(m); prev.amount = a.amount; prev.raw = a.raw; }
      continue;
    }
    out.push({ moiety: name, ...(m === null ? { amount: null, raw: null } : amountOf(m)) });
  }
  return out.length === 0 || out.length > MAX_COMPONENTS ? null : out;
}

function amountOf(m: RegExpExecArray): { amount: Amount | null; raw: string | null } {
  const n = Number(m[2]);
  const unit = (m[3] ?? "mg").replace(/\./g, "");
  const scale = unit === "mg" ? 1 : unit === "mcg" || unit === "µg" ? 0.001 : unit === "g" || unit === "gm" ? 1000 : null;
  const perMl = m[4] !== undefined ? Number(m[4]) : /\/\s*ml/.test(m[0]) ? 1 : null;
  if (scale === null) return { amount: null, raw: unit === "lac iu" ? String(n * 100_000) : String(n) };
  return { amount: { mg: n * scale, perMl }, raw: String(n) };
}

/** The form a vendor's row names, in its brand, packing or composition. `null` when it names none. */
export function twinFormOf(brand: string, pack: string, composition: string): { form: TwinForm; modifiedRelease: boolean } | null {
  const all = ` ${brand} ${pack} ${composition} `.toLowerCase();
  const p = pack.toLowerCase().trim();
  // "-MR" on an Indian NSAID brand (ETOHIT-MR, DOLZY-MR) is "muscle relaxant", not modified release; "30MR" is.
  // "DSR" (PUNCH-DSR) is domperidone sustained-release.
  const modifiedRelease = /\b(?:sr|er|xl|cr|dsr|s\.r|sustained|extended|modified|controlled|prolonged)\b|\d(?:sr|mr|xl)\b/.test(`${brand} ${composition}`.toLowerCase());
  const f = ((): TwinForm | null => {
    if (/respule|inhal|nebul/.test(all)) return "inhalation";
    if (/ophthalmic|opthalmic|\beye\b/.test(all)) return "eye_drop";
    if (/\bear\b|\botic\b/.test(all)) return "ear_drop";
    if (/nasal/.test(all)) return "nasal";
    if (/applicator|vaginal|pessar/.test(all)) return "vaginal";
    if (/mouthwash|gargle/.test(all)) return "oromucosal";
    if (/\b(?:gel|cream|ointment|oint|lotion|spray)\b/.test(all)) return "topical";
    if (/\b(?:syp|syrup|susp|sus|suspension|liquid|drops?|elixir)\b/.test(all)) return "oral_liquid";
    if (/\b(?:inj|injection|infusion|i\.?v|vial|amp|ampoule)\b/.test(all)) return "injection";
    if (/\b(?:sachet|granules|powder)\b/.test(all) || /\d\s*gm?\b/.test(p) && /[x×*]/.test(p)) return "sachet";
    if (/\b(?:cap|caps|capsules?|softgel)\b/.test(all)) return "capsule";
    if (/\b(?:tab|tabs|tablets?)\b/.test(all)) return "tablet";
    if (/^1\s*['’]?\s*s$/.test(p)) return "injection"; // a vendor's "1'S" with no tablet word is a vial
    const ml = /(\d+(?:\.\d+)?)\s*ml/.exec(p);
    if (ml !== null) return /[x×*]/.test(p) && Number(ml[1]) <= 10 ? "injection" : "oral_liquid";
    if (/\d\s*[x×*]\s*\d/.test(p) || /\btab\b/.test(p)) return "solid";
    return null;
  })();
  return f === null ? null : { form: f, modifiedRelease };
}

/** The class of a catalogue medicine's form, on the same scale as `twinFormOf`. */
export function catalogueTwinForm(form: string): TwinForm | null {
  const f = form.toLowerCase();
  if (/inhal|nebul|pressuri[sz]ed|respule/.test(f)) return "inhalation";
  if (/\beye\b|ophthalmic/.test(f)) return "eye_drop";
  if (/\bear\b|otic|auricular/.test(f)) return "ear_drop";
  if (/nasal/.test(f)) return "nasal";
  if (/vaginal/.test(f)) return "vaginal";
  if (/mouthwash|gargle|oromucosal/.test(f)) return "oromucosal";
  if (/inject|infusion/.test(f)) return "injection";
  const c = formClassOf(form);
  if (c === "tablet" || c === "capsule" || c === "oral_liquid" || c === "sachet" || c === "topical") return c;
  return null;
}

export const twinFormAgrees = (want: TwinForm, have: TwinForm | null): boolean => formAgrees(want, have);
const formAgrees = (want: TwinForm, have: TwinForm | null): boolean =>
  have !== null && (want === have || (want === "solid" && (have === "tablet" || have === "capsule")));

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Every strength the vendor wrote is in the template — each component its OWN strength. "Clopidogrel 75 + aspirin 75"
 * is not "aspirin 150 mg and clopidogrel 75 mg": two 75s need two 75s. Where the name says which moiety a strength
 * belongs to ("aspirin 150 mg and clopidogrel 75 mg"), that binds; the rest are matched one amount to one component.
 */
export function twinStrengthAgrees(spec: TwinSpec, name: string, label: string | null): boolean {
  const named = amountsInName(name);
  const fromLabel = parseStrengthLabel(label);
  const have = named.length > 0 ? named : fromLabel === null ? [] : [fromLabel];
  const numbers = new Set((name.replace(/(\d),(\d)/g, "$1$2").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))));
  const agree = (h: Amount, a: Amount): boolean => {
    if (sameAmount(h, a)) return true;
    if (a.perMl !== null || h.perMl === null) return false;
    // The vendor left the volume off a liquid's strength. Accepted only the ways Indian lists write it:
    // the catalogue's own numerator ("LACTULOSE 10GM" = 10 g/15 ml), a syrup per 5 ml ("100MG" = 20 mg/ml),
    // an injection per ml ("DROTAVERINE 20MG" in 2 ml ampoules = 20 mg/ml).
    if (spec.form !== "oral_liquid" && spec.form !== "injection") return false;
    return close(h.mg, a.mg) || (spec.form === "oral_liquid" && close((h.mg / h.perMl) * 5, a.mg)) || (spec.form === "injection" && close(h.mg / h.perMl, a.mg));
  };
  // "aspirin 150 mg and clopidogrel 75 mg": the segment naming a moiety carries its strength.
  // Only a GENERIC name binds this way: a brand's "(levofloxacin and ornidazole) 250 mg + 500 mg" lists the
  // strengths apart from the moieties, in order, and the matching below reads it.
  const plain = name.replace(/\s*\(as [^)]*\)/gi, "");
  const segments = plain.includes("(") ? [] : plain.toLowerCase().split(/\s+and\s+|\s*\+\s*/).map((seg) => ({ seg, amounts: amountsInName(seg) })).filter((x) => x.amounts.length > 0);
  const options: number[][] = [];
  for (const c of spec.components) {
    if (c.amount === null) {
      if (c.raw === null || !numbers.has(String(Number(c.raw)))) return false;
      continue;
    }
    const a = c.amount;
    const words = c.moiety.split(" ").filter((w) => w.length >= 5);
    const own = segments.find((x) => words.some((w) => x.seg.includes(w)));
    if (own !== undefined && !own.amounts.some((h) => agree(h, a))) return false;
    options.push(have.map((h, i) => (agree(h, a) ? i : -1)).filter((i) => i >= 0));
  }
  // One amount to one component (≤ 6 components: a tiny backtracking search).
  const used = new Set<number>();
  const assign = (k: number): boolean => {
    if (k === options.length) return true;
    for (const i of options[k]!) {
      if (used.has(i)) continue;
      used.add(i);
      if (assign(k + 1)) return true;
      used.delete(i);
    }
    return false;
  };
  return assign(0);
}

/** Salt-form words: the moiety is what is left. "Clavulanate potassium" → clavulanate. */
const COUNTER_ION = /\b(?:sodium|disodium|potassium|calcium|magnesium|hydrochloride|hcl|sulfate|sulphate|trihydrate|dihydrate|monohydrate|hemihydrate|sesquihydrate|anhydrous|besilate|besylate|maleate|succinate|tartrate|citrate|phosphate|acetate|bromide|hydrobromide|mesylate|mesilate|fumarate|axetil|proxetil|medoxomil|hyclate|propionate|dipropionate|valerate|bitartrate|lactate|gluconate|carbonate|decanoate|palmitate|enanthate|cypionate|undecanoate|hydrobromide|dimesylate|bromide)\b/g;
const moietyOf = (salt: string): string => salt.toLowerCase().replace(COUNTER_ION, " ").replace(/\s+/g, " ").trim() || salt.toLowerCase();

type SaltHit = { id: string; name: string; aliases: string[] | null };

/** A vendor's moiety → the family of catalogue salts that ARE it, or null when the catalogue has no such salt. */
async function saltFamily(db: Db | Tx, moiety: string): Promise<Set<string> | null> {
  const words = moiety.split(" ").filter((w) => w !== "");
  const tries = words.map((_, i) => words.slice(0, words.length - i).join(" ")).filter((w) => w.length >= 4);
  if (tries.length === 0) return null;
  const exact = await db.execute<SaltHit>(sql`
    select id, name, aliases from formulary_salts
     where active and (lower(name) = any(${sql.param(tries)}::text[])
       or exists (select 1 from jsonb_array_elements_text(aliases) a where lower(a) = any(${sql.param(tries)}::text[])))
  `);
  // Every salt that IS the phrase, by name or alias: "lumefantrine" is both a salt and benflumetol's alias.
  let hits: SaltHit[] = [];
  let said = "";
  for (const t of tries) {
    hits = exact.rows.filter((r) => r.name.toLowerCase() === t || (r.aliases ?? []).some((a) => a.toLowerCase() === t));
    if (hits.length > 0) { said = t; break; }
  }
  if (hits.length === 0) {
    // A misspelling the table above has not met: the nearest salt name, only when it is close.
    const near = await db.execute<SaltHit & { sim: number }>(sql`
      select id, name, aliases, similarity(lower(name), ${moiety}) as sim from formulary_salts
       where active and lower(name) % ${moiety} order by sim desc, length(name) limit 1
    `);
    const n = near.rows[0];
    if (n === undefined || Number(n.sim) < 0.55) return null;
    hits = [n];
    said = n.name.toLowerCase();
  }
  const roots = [...new Set([moietyOf(said), ...hits.map((h) => moietyOf(h.name))])];
  const family = await db.execute<{ id: string }>(sql`
    select id from formulary_salts
     where active and (lower(name) = any(${sql.param(roots)}::text[])
       or lower(name) like any(${sql.param(roots.flatMap((r) => [`${r} %`, `% ${r}`]))}::text[])
       or exists (select 1 from jsonb_array_elements_text(aliases) a where lower(a) = any(${sql.param(roots)}::text[])))
  `);
  return new Set([...hits.map((h) => h.id), ...family.rows.map((r) => r.id)]);
}

const FORM_SQL: Record<TwinForm, string> = {
  tablet: "tablet", capsule: "capsule", solid: "tablet|capsule", oral_liquid: "oral|syrup|suspension|solution|elixir|drops",
  injection: "inject|infusion", eye_drop: "eye|ophthalmic", ear_drop: "ear|otic|auricular", nasal: "nasal", topical: "cream|gel|ointment|lotion|cutaneous|topical|spray",
  inhalation: "inhal|nebul|pressuri", sachet: "sachet|granules|powder", vaginal: "vaginal", oromucosal: "mouthwash|gargle|oromucosal",
};

/**
 * One template per spec, or null. Each spec costs a few indexed reads: the salt families, then the medicines
 * that contain the first family, narrowed in SQL to the form and to a name carrying one of the vendor's numbers.
 */
export async function compositionTwins(db: Db | Tx, specs: readonly (TwinSpec | null)[], cache?: SaltFamilyCache): Promise<(CompositionTwin | null)[]> {
  const out: (CompositionTwin | null)[] = [];
  for (const spec of specs) out.push(spec === null ? null : await twinOf(db, spec, cache));
  return out;
}

/** A liquid's strengths share one volume: "SUCRALFATE 1 GM + OXETACAINE 20 MG/10 ML" is 1 g/10 ml as well. */
function sharedVolume(spec: TwinSpec): TwinSpec {
  if (spec.form !== "oral_liquid" && spec.form !== "injection") return spec;
  const vols = [...new Set(spec.components.map((c) => c.amount?.perMl).filter((v): v is number => v !== null && v !== undefined))];
  if (vols.length !== 1) return spec;
  return { ...spec, components: spec.components.map((c) => (c.amount !== null && c.amount.perMl === null ? { ...c, amount: { ...c.amount, perMl: vols[0]! } } : c)) };
}

/** The salt families of a spec's moieties, or null when one is unknown or two are the same moiety. */
/** One price list asks the same moieties again and again (paracetamol, 40 rows): a caller may share this per call. */
export type SaltFamilyCache = Map<string, Promise<Set<string> | null>>;

async function familiesOf(db: Db | Tx, spec: TwinSpec, cache?: SaltFamilyCache): Promise<Set<string>[] | null> {
  if (spec.components.length === 0 || spec.components.length > MAX_COMPONENTS) return null;
  if (spec.components.some((c) => c.amount === null && c.raw === null)) return null;
  const families: Set<string>[] = [];
  for (const c of spec.components) {
    let pending = cache?.get(c.moiety);
    if (pending === undefined) { pending = saltFamily(db, c.moiety); cache?.set(c.moiety, pending); }
    const f = await pending;
    if (f === null) return null;
    if (families.some((g) => [...g].some((id) => f.has(id)))) return null; // one moiety written twice: not a set we can trust
    families.push(f);
  }
  return families;
}

type Cand = { name: string; form: string; strength: string | null; saltIds: readonly string[] };

/** The four rules of the header, on one catalogue medicine. */
function passes(spec: TwinSpec, families: Set<string>[], c: Cand): boolean {
  if (c.saltIds.length !== families.length) return false;
  if (!families.every((f) => c.saltIds.filter((id) => f.has(id)).length === 1)) return false;
  if (!formAgrees(spec.form, catalogueTwinForm(c.form))) return false;
  if (isModifiedRelease(`${c.form} ${c.name}`) !== spec.modifiedRelease) return false;
  return twinStrengthAgrees(spec, c.name, c.strength);
}

/**
 * Does this catalogue medicine say what the vendor's row says — the same moieties, strengths, form and release?
 * The price-list import asks it of a match found by BRAND NAME: a catalogue that knows only "Seytri 250 mg vial"
 * must not become the vendor's "SEYTRI 1GM"; "Punch 40 mg vial" is not the vendor's PUNCH-40 tablet.
 */
export async function compositionAgrees(db: Db | Tx, spec: TwinSpec, medicine: Cand, cache?: SaltFamilyCache): Promise<boolean | null> {
  const s = sharedVolume(spec);
  const families = await familiesOf(db, s, cache);
  // A composition the catalogue cannot read (a moiety it has no salt for) says nothing either way.
  return families === null ? null : passes(s, families, medicine);
}

async function twinOf(db: Db | Tx, raw: TwinSpec, cache?: SaltFamilyCache): Promise<CompositionTwin | null> {
  const spec = sharedVolume(raw);
  const families = await familiesOf(db, spec, cache);
  if (families === null) return null;
  const nums = [...new Set(spec.components.flatMap((c) => {
    if (c.amount === null) return c.raw === null ? [] : [String(Number(c.raw))];
    const mg = c.amount.perMl === null ? c.amount.mg : c.amount.mg / c.amount.perMl;
    return [mg, mg / 1000, mg * 1000, c.amount.mg, c.amount.perMl === null ? c.amount.mg / 5 : 0].filter((n) => n > 0).map((n) => String(Number(n.toFixed(6))));
  }))];
  const numPattern = nums.length === 0 ? "." : `(^|[^0-9.])(${nums.map((n) => n.replace(/\./g, "\\.")).join("|")})([^0-9]|$)`;
  const res = await db.execute<{
    id: string; brand_name: string; form: string; strength_label: string | null; schedule_flag: string | null;
    route_class: string; code: string | null; salt_ids: string[]; salt_names: string[];
  }>(sql`
    select m.id, m.brand_name, m.form, m.strength_label, m.schedule_flag, m.route_class, m.code,
           array_agg(ms.salt_id order by ms.salt_id) as salt_ids, array_agg(s.name order by ms.salt_id) as salt_names
      from formulary_medicines m
      join formulary_medicine_salts ms on ms.medicine_id = m.id
      join formulary_salts s on s.id = ms.salt_id
     where m.active
       and m.form ~* ${FORM_SQL[spec.form]}
       and (replace(m.brand_name, ',', '') ~* ${numPattern} or coalesce(m.strength_label, '') ~* ${numPattern})
       and m.id in (select medicine_id from formulary_medicine_salts where salt_id = any(${sql.param([...families[0]!])}::text[]))
     group by m.id
    having count(*) = ${families.length}
     order by (m.code is null), length(m.brand_name), m.id
     limit 400
  `);
  // Which template, when several agree: a short generic name, then a brand-style name, the SNOMED sentence
  // ("Product containing precisely …") last; for a row that only said "10*10", a tablet before a capsule.
  const rank = (r: { brand_name: string; code: string | null; form: string }): number =>
    (/^product containing/i.test(r.brand_name) ? 4 : r.code !== null ? 0 : 2) + (spec.form === "solid" && /capsule/i.test(r.form) ? 1 : 0);
  const agreeing = res.rows
    .filter((r) => passes(spec, families, { name: r.brand_name, form: r.form, strength: r.strength_label, saltIds: r.salt_ids }))
    .sort((a, b) => rank(a) - rank(b) || a.brand_name.length - b.brand_name.length || (a.id < b.id ? -1 : 1));
  const r = agreeing[0];
  if (r === undefined) return null;
  // The vendor wrote a bare moiety and the catalogue has it as two different salts (methylprednisolone ACETATE,
  // a depot, and SODIUM SUCCINATE, for a drip): the screen must make the person choose, not guess for them.
  // The catalogue often links both to the bare moiety, so the injection's KIND tells them apart as well: a
  // suspension (depot, never IV) against a solution or a powder for one.
  const saltSet = (x: { salt_ids: string[] }): string => [...x.salt_ids].sort().join(",");
  const kind = (x: { form: string; brand_name: string }): string =>
    spec.form !== "injection" ? "" : /suspension|depot/i.test(`${x.form} ${x.brand_name}`) ? "suspension" : /emulsion|liposom/i.test(x.form) ? "emulsion" : "solution";
  const groups = new Map<string, (typeof agreeing)[number]>();
  for (const x of agreeing) if (!groups.has(`${saltSet(x)}|${kind(x)}`)) groups.set(`${saltSet(x)}|${kind(x)}`, x);
  const view = (x: (typeof agreeing)[number]): Omit<CompositionTwin, "ambiguous" | "others"> => ({
    medicineId: x.id, name: x.brand_name, form: x.form, strength: x.strength_label, schedule: x.schedule_flag,
    routeClass: x.route_class, generic: x.code !== null, salts: x.salt_names,
  });
  const others = [...groups.values()].filter((x) => x !== r).slice(0, 3).map(view);
  return { ...view(r), ambiguous: others.length > 0, others };
}

/** "SAZOTEL-40 TAB" → "Sazotel-40": the vendor's brand, its form word dropped, in the catalogue's case. */
export function brandTitle(brand: string): string {
  const core = brand.trim().replace(/[\s.]+(?:tab|tabs|tablet|syp|syrup|inj|injection|cap|caps)\.?$/i, "").replace(/\s+/g, " ");
  return core.split(/(\s|-)/).map((w) => (/^[a-z]{1,3}$/i.test(w) ? w.toUpperCase() : /^[a-z]/i.test(w) ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w)).join("");
}

/**
 * The catalogue name the vendor's brand gets, written the way the catalogue writes a brand:
 * "Sazotel-40 (telmisartan) 40 mg oral tablet". From a brand template the "(salts) rest" is taken as it is;
 * from a generic template ("Telmisartan 40 mg oral tablet") the whole generic name goes in the brackets.
 */
export function twinName(brand: string, template: { name: string; generic?: boolean }): string {
  const title = brandTitle(brand);
  const name = tidyCatalogueName(template.name);
  // A brand template ("Telma (telmisartan) 40 mg oral tablet") lends its "(salts) rest"; a generic one is the
  // whole description, in brackets after the vendor's brand.
  const open = name.indexOf(" (");
  const brandStyle = template.generic !== true && !/^product containing/i.test(template.name) && open > 0;
  const tail = brandStyle ? name.slice(open + 1) : `(${name.charAt(0).toLowerCase()}${name.slice(1)})`;
  return `${title} ${tail}`.slice(0, 300);
}

/** The SNOMED sentence in the words a label uses: "Product containing precisely drotaverine 20 milligram/1 milliliter
 *  conventional release solution for injection (clinical drug)" → "drotaverine 20 mg/ml solution for injection". */
export function tidyCatalogueName(name: string): string {
  return name.replace(/^product containing precisely\s+/i, "").replace(/\s*\(clinical drug\)\s*$/i, "")
    .replace(/\bconventional release\s+/gi, "").replace(/\bmilligrams?\b/gi, "mg").replace(/\bmicrograms?\b/gi, "mcg")
    .replace(/\bgrams?\b/gi, "g").replace(/\bmillilit(?:er|re)s?\b/gi, "ml").replace(/\/1 each\b/gi, "").replace(/\/1 ml\b/gi, "/ml")
    .replace(/\binternational units?\b/gi, "IU").replace(/\s*\(as [^)]*\)/gi, "").replace(/>(\d)</g, "$1")
    .replace(/\s+/g, " ").trim();
}
