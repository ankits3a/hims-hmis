import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  addMedicine, catalogueTwinForm, compositionAgrees, compositionTwins, medicineIdsByBrandNames, medicinesByBrandPrefix, medicinesByIds, parseComposition,
  saltsByIds, searchMedicines, twinFormAgrees, twinFormOf, twinName,
} from "../formulary";
import type { CompositionTwin, MedicineHit, MedicineWithSalts, RouteClass, SaltFamilyCache, TwinForm } from "../formulary";
import { createStockDrug, stockEntryItems } from "./stock-drug";
import { PharmacyError } from "./errors";
import type { PackType } from "./opening-stock";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ A VENDOR'S PRICE LIST INTO THE ITEM MASTER (owner 2026-10-04) ═══
 *
 * "The vendor gave me a list of drugs: manufacturer, brand, composition, packing." Typing hundreds of drugs one
 * by one through + New drug is slow and error-prone. The screen reads the vendor's sheet (CSV or Excel) in the
 * browser and sends its rows here, twice:
 *
 *   1. MATCH (writes nothing): each row's brand is looked up in the national catalogue (`searchMedicines`, the
 *      same search the new-drug sheet uses) and the best candidate is chosen by brand words, strength and
 *      composition; the pack text ("10x10", "100 ml", "1 vial") becomes a pack type and size; a brand already in
 *      the item master is said so. A person reviews every row and may pick another candidate.
 *
 *      Since the Aptus Drugs list (owner 2026-10-04, 206 rows of Hauz Pharma brands):
 *        · a NAME match must also agree with the row's composition, strength and form — the catalogue knew
 *          "Seytri 250 mg vial" and "Thyrosoft 100 mcg" and offered them for SEYTRI 1GM and THYROSOFT-25;
 *        · a brand the catalogue lacks (151 of the 206) is matched by its COMPOSITION to the catalogue drug it
 *          copies (`formulary/twins.ts`) and offered as a TWIN: the brand is added to the catalogue with that
 *          drug's salts and schedule when the row is created;
 *        · the packing is read as Indian lists write it ("4*5*10", "10*1*6", "5*2ML") with `outer`, how many packs
 *          it holds, so an MRP quoted for the whole packing can become the MRP of the pack the counter sells.
 *      Measured on that list against the staging catalogue: 27 brand matches, 102 twins, 77 left for a person
 *      (nutraceutical blends, devices, three rows whose composition the vendor got wrong) — in about a minute.
 *   2. CREATE: each ticked row goes through `createStockDrug` — the very call + New drug makes, with every guard
 *      and permission it has — one at a time, so one bad row never stops the others, and each row says what
 *      became of it.
 */
export type PriceListRow = { manufacturer?: string; brand: string; composition?: string; pack?: string; mrp?: string; gst?: string; hsn?: string };
export type MatchCandidate = { medicineId: string; name: string; form: string; strength: string | null; salts: string[]; schedule: string | null; score: number };
export type MatchedRow = {
  line: number; brand: string; manufacturer: string; composition: string; pack: string;
  best: MatchCandidate | null; alternatives: MatchCandidate[];
  /** The item master already has this brand in this form and strength: no new item is made. */
  existing: { itemId: string; code: string; name: string } | null;
  /**
   * The brand is not in the catalogue (or the catalogue's brand of that name is another composition), but a
   * catalogue medicine has the vendor's composition, strength and form: the brand can be ADDED to the catalogue
   * as `newName`, carrying the template's salts and schedule (`formulary/twins.ts`).
   */
  twin: (CompositionTwin & { newName: string; others: (CompositionTwin["others"][number] & { newName: string })[] }) | null;
  /** Two rows of one brand and form in different sizes (100 ml, 200 ml): the size goes in the item's name. */
  variant: string | null;
  /** How many packs the vendor's packing holds ("10*15" → 10): an MRP quoted for the packing is divided by it. */
  outer: number;
  packType: PackType; packSize: number; gstRateBps: number; hsnCode: string; mrpPerPackPaise: number | null;
};

const MAX_ROWS = 1000;
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
const numbers = (s: string): string[] => (s.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));

/**
 * "10x10", "1 x 15 tab", "100ml", "1 vial", "4*5*10", "10*1*6", "5*2ML", "10*2ML*5", "1'S" → a pack type, how many
 * base units one pack holds, and how many packs the vendor's PACKING holds (`outer`).
 *
 * Indian price lists write the packing as a product of counts: "10*15" is ten strips of fifteen, "4*5*10" is
 * twenty strips of ten, "10*1*6" ten strips of six, "5*2ML" five 2 ml ampoules. For a tablet or capsule the LAST
 * count is the strip; every other count multiplies into `outer`. For anything sold whole (a vial, a bottle, a
 * tube, a sachet) one pack is one container and every count is `outer`; a "2ML" or "21.8 GM" is the size of a
 * container, never a count. The screen needs `outer` to turn an MRP quoted for the whole packing into the MRP
 * of the pack the counter sells.
 */
export function parsePack(text: string, form: string): { packType: PackType; packSize: number; outer: number } {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  const f = `${form} ${t}`.toLowerCase();
  const factors = t.split(/\s*[x×*]\s*/).map((x) => /^\s*(\d+(?:\.\d+)?)\s*([a-z']*)/.exec(x)).filter((m): m is RegExpExecArray => m !== null);
  const counts = factors.filter((m) => !/^(ml|l|ltr|gm?|kg|mg|mcg)$/.test(m[2]!)).map((m) => Number(m[1]));
  const size = (n: number): number => (Number.isSafeInteger(n) && n >= 1 && n <= 1000 ? n : 1);
  const product = (ns: number[]): number => { const p = ns.reduce((a, b) => a * b, 1); return Number.isSafeInteger(p) && p >= 1 && p <= 100_000 ? p : 1; };
  const strip = (packType: PackType): { packType: PackType; packSize: number; outer: number } =>
    ({ packType, packSize: size(counts[counts.length - 1] ?? 1), outer: product(counts.slice(0, -1)) });
  const whole = (packType: PackType): { packType: PackType; packSize: number; outer: number } => ({ packType, packSize: 1, outer: product(counts) });
  if (/capsule|\bcap\b|softgel/.test(f)) return strip("capsule_strip");
  if (/tablet|\btab\b|strip/.test(f)) return strip("tablet_strip");
  if (/ampoule|\bamp\b/.test(f)) return whole("ampoule");
  if (/powder|vial/.test(f) && /injection|infusion|\binj\b/.test(f)) return whole("vial");
  if (/infusion/.test(f)) return whole("bottle");
  if (/injection|\binj\b/.test(f)) return whole(/\d\s*ml/.test(t) ? "ampoule" : "vial");
  // "25*21.8 GM" of an oral powder is sachets, though the powder is "for oral solution".
  if (/\d\s*gm?\b/.test(t) && /sachet|powder|granule/.test(f)) return whole("sachet");
  if (/syrup|suspension|solution|drop|liquid|\bml\b|\dml|bottle|lotion/.test(f)) return whole("bottle");
  if (/cream|ointment|gel|tube/.test(f)) return whole("tube");
  if (/sachet|powder|granule/.test(f)) return whole("sachet");
  // No form named and a product of counts ("10*10"): Indian lists mean strips.
  if (counts.length >= 2 && !/\d\s*(ml|gm?)\b/.test(t)) return strip("tablet_strip");
  return whole("other");
}

/** ₹ text ("₹ 35.50", "35.5", "Rs.120/-") → paise, or null. */
export function rupeesToPaise(text: string | undefined): number | null {
  if (text === undefined) return null;
  const m = /(\d+(?:\.\d{1,2})?)/.exec(text.replace(/,/g, ""));
  if (m === null) return null;
  const p = Math.round(Number(m[1]) * 100);
  return p > 0 ? p : null;
}

/** "5", "5%", "12 %" → bps; medicines default to 5% (no 12% slab since 22 Sep 2025). */
function gstBps(text: string | undefined): number {
  const m = text === undefined ? null : /(\d+(?:\.\d+)?)/.exec(text);
  const v = m === null ? 5 : Number(m[1]);
  return [0, 5, 18].includes(v) ? v * 100 : 500;
}

/** Words vendors put in a brand that name the form, not the brand ("Augmentin Duo Syrup", "Deriphyllin Inj"). */
const FORM_WORDS = new Set(["tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule", "capsules", "syp", "syrup", "susp", "suspension", "inj", "injection",
  "drop", "drops", "cream", "gel", "ointment", "oint", "lotion", "sachet", "powder", "vial", "amp", "ampoule", "ml", "mg", "gm", "strip", "bottle", "dt", "md"]);
/** "Moxikind-CV 625" → "moxikind cv 625"; form words dropped. */
const brandCore = (brand: string): string => norm(brand.replace(/[-/+]/g, " ")).split(" ").filter((w) => w !== "" && !FORM_WORDS.has(w)).join(" ");
const FORM_HINT: [RegExp, RegExp][] = [
  [/\b(syp|syrup|susp|suspension|liquid|ml)\b/, /suspension|syrup|solution|liquid/],
  [/\b(inj|injection|vial|amp|ampoule)\b/, /injection|infusion/],
  [/\b(drop|drops)\b/, /drop/],
  [/\b(cream|gel|ointment|oint|lotion)\b/, /cream|gel|ointment|lotion/],
  [/\b(cap|caps|capsule)\b/, /capsule/],
];

/** How well a catalogue medicine answers a row: brand words, strength numbers, composition words, the form named. */
function score(row: { brand: string; composition: string; pack: string }, hit: MedicineHit): number {
  const brandWords = brandCore(row.brand).split(" ").filter((w) => w.length > 0);
  const name = norm(hit.name.replace(/[-/+]/g, " "));
  let s = 0;
  if (brandWords.length > 0 && name.startsWith(brandWords[0]!)) s += 40;
  s += 30 * (brandWords.filter((w) => name.split(" ").includes(w)).length / Math.max(1, brandWords.length));
  const wantNums = new Set([...numbers(row.brand), ...numbers(row.composition)]);
  const haveNums = new Set([...numbers(hit.name), ...numbers(hit.strength ?? "")]);
  if (wantNums.size > 0) s += 20 * ([...wantNums].filter((n) => haveNums.has(n)).length / wantNums.size);
  // The catalogue's own brand words (before the "(salt)") the vendor did not write: "Pan Xpr" is not "Pan 40".
  const catBrand = norm((hit.name.split("(")[0] ?? "").replace(/[-/+]/g, " ")).split(" ").filter((w) => w !== "" && !/^\d/.test(w) && !FORM_WORDS.has(w));
  s -= 12 * catBrand.filter((w) => !brandWords.includes(w)).length;
  // The form the vendor named, in the brand or the packing ("15 Tab", "30 ml", "Inj"): the wrong form is a wrong drug.
  const raw = `${row.brand} ${row.pack}`.toLowerCase();
  const hitForm = `${hit.form} ${hit.name}`.toLowerCase();
  const injected = FORM_HINT[1]![0].test(raw);
  const said = FORM_HINT.filter(([w], i) => w.test(raw) && !(injected && i === 0)); // "2 ml amp" is an injection, not a syrup
  const isInjection = /injection|infusion/.test(hitForm);
  for (const [w, form] of said) s += form.test(hitForm) && !(isInjection && w !== FORM_HINT[1]![0]) ? 15 : -20;
  if (said.length === 0 && (/\b(tab|tabs|tablet|strip)\b/.test(raw) || /\d+\s*[x×*]\s*\d+/.test(raw))) s += /tablet|capsule/.test(hitForm) ? 15 : -20;
  // …and the vendor's brand words the catalogue name lacks: "Glycomet GP 1" is not "Glycomet".
  s -= 15 * brandWords.filter((w) => !/^\d/.test(w) && !name.split(" ").includes(w)).length;
  const comp = norm(row.composition);
  if (comp !== "" && hit.salts.length > 0) {
    const salted = hit.salts.filter((x) => comp.includes(norm(x).split(" ")[0] ?? "§")).length / hit.salts.length;
    s += 10 * salted;
  }
  return Math.round(s);
}

export async function matchPriceList(db: Db, rows: readonly PriceListRow[]): Promise<MatchedRow[]> {
  if (rows.length === 0) throw new PharmacyError("nothing_to_dispense", "the price list has no rows");
  if (rows.length > MAX_ROWS) throw new PharmacyError("invalid_range", `a price list is read ${String(MAX_ROWS)} rows at a time; this one has ${String(rows.length)}`);
  const out = new Array<Omit<MatchedRow, "variant">>(rows.length);
  const cache: SaltFamilyCache = new Map();
  // Rows are independent: eight at a time (a 1,000-row list in about a minute, not ten).
  const CHUNK = 8;
  for (let at = 0; at < rows.length; at += CHUNK) {
    await Promise.all(rows.slice(at, at + CHUNK).map(async (r, k) => { out[at + k] = await matchOne(db, r, at + k, cache); }));
  }
  // One brand, one form, two sizes (MULTIGING syrup 100 ml and 200 ml): two items, told apart by the size.
  const key = (m: Omit<MatchedRow, "variant">): string => `${brandWordsOf(m.brand).join(" ")}|${numbers(brandCore(m.brand)).join(" ")}|${twinFormOf(m.brand, m.pack, m.composition)?.form ?? ""}`;
  const groups = new Map<string, Set<string>>();
  for (const m of out) if (m.brand !== "") groups.set(key(m), (groups.get(key(m)) ?? new Set()).add(m.pack.toLowerCase().replace(/\s+/g, "")));
  return out.map((m) => ({ ...m, variant: m.brand !== "" && (groups.get(key(m))?.size ?? 0) > 1 && m.pack !== "" ? m.pack.toLowerCase().replace(/\s+/g, " ").trim() : null }));
}

async function matchOne(db: Db, r: PriceListRow, i: number, cache: SaltFamilyCache): Promise<Omit<MatchedRow, "variant">> {
  const brand = (r.brand ?? "").trim();
  const composition = (r.composition ?? "").trim();
  const base = { line: i + 1, brand, manufacturer: (r.manufacturer ?? "").trim(), composition, pack: (r.pack ?? "").trim() };
  const money = { gstRateBps: gstBps(r.gst), hsnCode: hsnOf(r.hsn), mrpPerPackPaise: rupeesToPaise(r.mrp) };
  if (brand === "") {
    return { ...base, best: null, alternatives: [], existing: null, twin: null, ...parsePack(base.pack, ""), ...money };
  }
  const strengthNum = numbers(composition)[0];
  const core = brandCore(brand);
  const words = core.split(" ").filter((w) => w !== "");
  // The vendor's spelling first, then looser: no form words or hyphens, then the first two words, then the first.
  const queries = [...new Set([
    brand, core,
    ...(strengthNum !== undefined && !numbers(core).includes(strengthNum) ? [`${core} ${strengthNum}`] : []),
    ...(words.length > 2 ? [words.slice(0, 2).join(" ")] : []),
    ...(words.length > 1 && (words[0] ?? "").length >= 4 ? [words[0]!] : []),
  ].filter((q) => q.trim().length >= 2))];
  // The composition column, read: the form the row names and, when it parses, the catalogue drug it copies.
  const formSaid = twinFormOf(brand, base.pack, composition);
  const components = composition === "" ? null : parseComposition(composition);
  const template = components === null || formSaid === null ? null
    : (await compositionTwins(db, [{ components, form: formSaid.form, modifiedRelease: formSaid.modifiedRelease }], cache))[0] ?? null;

  const hits = new Map<string, MedicineHit>();
  // The exact brand first; only when the catalogue has no such brand does the looser search ladder run — and
  // not at all when the composition already found the drug: a fuzzy NAME hit for a brand the catalogue lacks is
  // another company's product (and the ladder is the slow part of a 200-row list).
  for (const h of await byBrandStem(db, core)) hits.set(h.id, h);
  if (hits.size === 0 && words.filter((w) => !/^\d/.test(w)).length > 1) for (const h of await byBrandStem(db, words.filter((w) => !/^\d/.test(w)).slice(0, -1).join(" "))) hits.set(h.id, h);
  if (hits.size === 0 && template === null) for (const q of queries) for (const h of await searchMedicines(db, q, 25)) hits.set(h.id, h);
  const ranked = [...hits.values()].map((h) => ({ h, s: score({ brand, composition, pack: base.pack }, h) })).sort((a, b) => b.s - a.s).slice(0, 8);
  const meds = await medicinesByIds(db, ranked.map((x) => x.h.id));
  const cands: MatchCandidate[] = ranked.map(({ h, s }) => ({
    medicineId: h.id, name: h.name, form: h.form, strength: h.strength, salts: h.salts, schedule: meds.get(h.id)?.scheduleFlag ?? null, score: s,
  }));
  // A NAME match must also say what the row says. The catalogue may know the brand in one strength or form only
  // ("Seytri 250 mg vial", "Punch 40 mg vial", "Thyrosoft 100 mcg"): that is not the vendor's SEYTRI 1GM, PUNCH-40
  // tablet or THYROSOFT-25. With a readable composition the whole of it is checked (moieties, strengths, form,
  // release); without one, the form the row names and every number in its brand.
  const spec = components !== null && formSaid !== null ? { components, form: formSaid.form, modifiedRelease: formSaid.modifiedRelease } : null;
  const brandNums = numbers(brandCore(brand));
  const agrees = async (c: MatchCandidate): Promise<boolean> => {
    const m = meds.get(c.medicineId);
    if (m === undefined) return false;
    const verdict = spec === null ? null : await compositionAgrees(db, spec, { name: m.brandName, form: m.form, strength: m.strengthLabel, saltIds: m.salts.map((x) => x.saltId) }, cache);
    // Checked against the composition, a lower name score will do; unchecked, the name must carry it alone.
    if (verdict !== null) return verdict && c.score >= 40;
    if (c.score < 50) return false;
    if (formSaid !== null && !twinFormAgrees(formSaid.form, catalogueTwinForm(m.form) ?? formSaid.form)) return false;
    // A composition the catalogue cannot fully read still names its moieties: most of the match's must be there.
    // ("NOZY-NS: sodium chloride + benzalkonium" is not Nozy's xylometazoline.)
    if (composition !== "") {
      const text = composition.toLowerCase();
      const salts = [...(await saltsByIds(db, m.salts.map((x) => x.saltId))).values()];
      const named = salts.filter((x) => text.includes(x.name.toLowerCase().slice(0, 5))).length;
      if (salts.length > 0 && (named === 0 || named * 2 < salts.length)) return false;
    }
    const inName = numbers(`${m.brandName} ${m.strengthLabel ?? ""}`);
    return brandNums.every((n) => inName.includes(n));
  };
  let best: MatchCandidate | null = null;
  for (const c of cands) if (await agrees(c)) { best = c; break; }
  const twin = best === null && template !== null
    ? { ...template, newName: twinName(brand, template), others: template.others.map((o) => ({ ...o, newName: twinName(brand, o) })) }
    : null;

  const existing = await existingItem(db, brand, formSaid?.form ?? null);
  return {
    ...base, best, alternatives: cands.filter((c) => c !== best).slice(0, 4), existing, twin,
    ...parsePack(base.pack, `${best?.form ?? template?.form ?? ""} ${composition} ${brand}`), ...money,
  };
}

/** The brand's words before its strength and form: "SAZOTEL-H 40 TAB" → ["sazotel", "h"]. */
const brandWordsOf = (name: string): string[] => brandCore(name.split(" (")[0] ?? name).split(" ").filter((w) => w !== "" && !/^\d/.test(w) && !/^\d+(mg|gm|g|ml|mcg)$/.test(w));

/**
 * The item already on the master for this row: the SAME brand words (not a prefix — "Seytri" is not
 * "Seytri-S"), every number the vendor's brand carries, and the same form ("Litrate" syrup is not the tablet).
 */
async function existingItem(db: Db, brand: string, form: TwinForm | null): Promise<{ itemId: string; code: string; name: string } | null> {
  const want = brandWordsOf(brand);
  if (want.length === 0) return null;
  const nums = numbers(brandCore(brand));
  const found = (await stockEntryItems(db, want.join(" "))).find((x) => {
    const have = brandWordsOf(x.name);
    if (have.length !== want.length || have.some((w, k) => w !== want[k])) return false;
    if (form !== null && x.form !== null) {
      const f = catalogueTwinForm(x.form);
      if (f !== null && !(f === form || (form === "solid" && (f === "tablet" || f === "capsule")))) return false;
    }
    const inName = numbers(x.name);
    return nums.every((n) => inName.includes(n));
  });
  return found === undefined ? null : { itemId: found.itemId, code: found.code, name: found.name };
}

/**
 * The catalogue rows whose BRAND is the vendor's brand: "Pan (pantoprazole…)", "Moxikind-CV (…)". The search
 * ranks generics and short names first, so a short brand ("Pan") can be buried under "Pantoprazole", "Panz",
 * "Panto"; this reads the brand stem directly — the words before the strength, a hyphen or a space between them.
 */
async function byBrandStem(db: Db, core: string): Promise<MedicineHit[]> {
  const words = core.split(" ").filter((w) => w !== "" && !/^\d/.test(w));
  if (words.length === 0 || words.join("").length < 2) return [];
  const clean = words.map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w !== "");
  if (clean.join("").length < 2) return [];
  // The catalogue writes "Brand (salt) strength form": read exactly "<brand> (", with a space or a hyphen between words.
  // …and "<brand> " too ("Crocin 500", "Pan D"): every hit is checked against the row's composition before it is
  // offered, so a wider read costs a few rows, never a wrong match.
  const prefixes = [...new Set([`${clean.join(" ")} (`, `${clean.join("-")} (`, `${clean.join("")} (`, `${clean.join(" ")} `])];
  const rows = (await Promise.all(prefixes.map((p) => medicinesByBrandPrefix(db, p, 60)))).flat();
  return [...new Map(rows.map((r) => [r.id, r] as const)).values()].map((r) => ({ ...r, salts: [], prefix: true, reviewed: true }));
}

function hsnOf(text: string | undefined): string {
  const digits = (text ?? "").replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 8 ? digits : "3004";
}

export type ImportRow = {
  line: number; medicineId: string; brand: string; packType: PackType; packSize: number;
  gstRateBps: number; hsnCode: string; mrpPerPackPaise: number; storage: "ambient" | "cold_2_8";
  /** `medicineId` is a TEMPLATE: the vendor's brand is first added to the catalogue with its composition. */
  twin?: boolean;
  /** The pack size that tells two items of one brand apart ("200 ml"). */
  variant?: string | null;
};
export type ImportResult = { line: number; ok: true; itemId: string; code: string; name: string } | { line: number; ok: false; code: string; message: string };

/**
 * Each ticked row through `createStockDrug` — the + New drug call, every guard and permission — one row at a time.
 *
 * A TWIN row first adds the vendor's brand to the catalogue (`addMedicine`, the formulary screen's own act, so
 * `formulary.manage` is asked once, up front) with the template's salts, strengths, form, route and schedule —
 * then makes the item from it. The catalogue row is its own transaction: when the item is then refused (a
 * duplicate), the brand stays in the catalogue and the next import finds it by name instead of adding it again.
 */
export async function importPriceList(db: Db, actor: Actor, rows: readonly ImportRow[], now: Date = new Date()): Promise<ImportResult[]> {
  if (rows.length > MAX_ROWS) throw new PharmacyError("invalid_range", `at most ${String(MAX_ROWS)} items at a time`);
  if (rows.some((r) => r.twin === true) && !(await hasPermission(db, actor.id, "formulary.manage", "hospital"))) {
    throw new PharmacyError("permission_denied", "adding a brand to the drug catalogue needs formulary.manage — ask the pharmacist in charge", { lacking: ["formulary.manage"] });
  }
  const meds = await medicinesByIds(db, [...new Set(rows.map((r) => r.medicineId))]);
  const out: ImportResult[] = [];
  for (const r of rows) {
    try {
      const medicineId = r.twin === true ? await ensureTwin(db, actor, r.brand, meds.get(r.medicineId)) : r.medicineId;
      const med = r.twin === true ? (await medicinesByIds(db, [medicineId])).get(medicineId) : meds.get(r.medicineId);
      const brandName = med?.brandName ?? r.brand;
      const made = await createStockDrug(db, actor, {
        brandName: r.variant ? `${brandName} ${r.variant}` : brandName, strength: med?.strengthLabel ?? "", medicineId, form: med?.form ?? "",
        packType: r.packType, packSize: r.packSize, hsnCode: r.hsnCode, gstRateBps: r.gstRateBps,
        schedule: null, mrpPerPackPaise: r.mrpPerPackPaise, storage: r.storage,
      }, now);
      out.push({ line: r.line, ok: true, itemId: made.itemId, code: made.code, name: made.name });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "permission_denied") throw e; // nobody without the right should get N refusals for one reason
      out.push({ line: r.line, ok: false, code: err.code ?? "error", message: err.message ?? String(e) });
    }
  }
  return out;
}

/** The vendor's brand in the catalogue: found by its twin name, or added with the template's composition. */
async function ensureTwin(db: Db, actor: Actor, brand: string, template: MedicineWithSalts | undefined): Promise<string> {
  if (template === undefined) throw new PharmacyError("invalid_range", "the catalogue drug this brand copies is gone — match the list again");
  const name = twinName(brand, { name: template.brandName, generic: template.code !== null });
  const known = (await medicineIdsByBrandNames(db, [name])).get(name.toLowerCase());
  if (known !== undefined) return known;
  const made = await withTx(db, (tx) => addMedicine(tx, actor, {
    brandName: name, form: template.form, routeClass: template.routeClass as RouteClass,
    strengthLabel: template.strengthLabel, scheduleFlag: template.scheduleFlag,
    salts: template.salts.map((x) => ({ saltId: x.saltId, strength: x.strength })),
    // The national catalogue already carries this exact composition as a product: it was admitted there.
    acknowledgeIntraFdc: true,
  }));
  return made.medicineId;
}
