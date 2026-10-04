import { sql } from "drizzle-orm";
import { formularyMedicines } from "../../kernel/db/schema";
import { medicinesByIds, searchMedicines } from "../formulary";
import type { MedicineHit } from "../formulary";
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
 *   2. CREATE: each ticked row goes through `createStockDrug` — the very call + New drug makes, with every guard
 *      and permission it has — one at a time, so one bad row never stops the others, and each row says what
 *      became of it.
 */
export type PriceListRow = { manufacturer?: string; brand: string; composition?: string; pack?: string; mrp?: string; gst?: string; hsn?: string };
export type MatchCandidate = { medicineId: string; name: string; form: string; strength: string | null; salts: string[]; schedule: string | null; score: number };
export type MatchedRow = {
  line: number; brand: string; manufacturer: string; composition: string; pack: string;
  best: MatchCandidate | null; alternatives: MatchCandidate[];
  /** The item master already has this brand (same normalized name): no new item is made. */
  existing: { itemId: string; code: string; name: string } | null;
  packType: PackType; packSize: number; gstRateBps: number; hsnCode: string; mrpPerPackPaise: number | null;
};

const MAX_ROWS = 1000;
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
const numbers = (s: string): string[] => (s.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));

/** "10x10", "1 x 15 tab", "100ml", "1 vial", "Strip of 10" → a pack type and how many base units a pack holds. */
export function parsePack(text: string, form: string): { packType: PackType; packSize: number } {
  const t = text.toLowerCase();
  const f = `${form} ${t}`.toLowerCase();
  const xs = /(\d+)\s*[x×*]\s*(\d+)/.exec(t);
  const first = /(\d+)/.exec(t);
  const count = xs !== null ? Number(xs[2]) : first !== null ? Number(first[1]) : 1;
  const size = (n: number): number => (Number.isSafeInteger(n) && n >= 1 && n <= 1000 ? n : 1);
  if (/capsule|\bcap\b/.test(f)) return { packType: "capsule_strip", packSize: size(count) };
  if (/tablet|\btab\b|strip/.test(f)) return { packType: "tablet_strip", packSize: size(count) };
  if (/ampoule|\bamp\b/.test(f)) return { packType: "ampoule", packSize: 1 };
  if (/vial|injection|\binj\b/.test(f)) return { packType: "vial", packSize: 1 };
  if (/syrup|suspension|solution|drop|liquid|\bml\b|bottle|lotion/.test(f)) return { packType: "bottle", packSize: 1 };
  if (/cream|ointment|gel|tube/.test(f)) return { packType: "tube", packSize: 1 };
  if (/sachet|powder|granule/.test(f)) return { packType: "sachet", packSize: 1 };
  return { packType: "other", packSize: 1 };
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
  if (said.length === 0 && /\b(tab|tabs|tablet|strip)\b/.test(raw)) s += /tablet/.test(hitForm) ? 15 : -20;
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
  const out: MatchedRow[] = [];
  for (const [i, r] of rows.entries()) {
    const brand = (r.brand ?? "").trim();
    const composition = (r.composition ?? "").trim();
    const base = { line: i + 1, brand, manufacturer: (r.manufacturer ?? "").trim(), composition, pack: (r.pack ?? "").trim() };
    if (brand === "") {
      out.push({ ...base, best: null, alternatives: [], existing: null, ...parsePack(base.pack, ""), gstRateBps: gstBps(r.gst), hsnCode: hsnOf(r.hsn), mrpPerPackPaise: rupeesToPaise(r.mrp) });
      continue;
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
    const hits = new Map<string, MedicineHit>();
    for (const q of queries) for (const h of await searchMedicines(db, q, 25)) hits.set(h.id, h);
    for (const h of await byBrandStem(db, core)) if (!hits.has(h.id)) hits.set(h.id, h);
    const ranked = [...hits.values()].map((h) => ({ h, s: score({ brand, composition, pack: base.pack }, h) })).sort((a, b) => b.s - a.s).slice(0, 4);
    const meds = await medicinesByIds(db, ranked.map((x) => x.h.id));
    const cands: MatchCandidate[] = ranked.map(({ h, s }) => ({
      medicineId: h.id, name: h.name, form: h.form, strength: h.strength, salts: h.salts, schedule: meds.get(h.id)?.scheduleFlag ?? null, score: s,
    }));
    const best = cands[0] !== undefined && cands[0].score >= 40 ? cands[0] : null;
    const existing = (await stockEntryItems(db, brand)).find((x) => norm(x.name).startsWith(norm(brand)));
    out.push({
      ...base, best, alternatives: cands.filter((c) => c !== best),
      existing: existing === undefined ? null : { itemId: existing.itemId, code: existing.code, name: existing.name },
      ...parsePack(base.pack, best?.form ?? composition), gstRateBps: gstBps(r.gst), hsnCode: hsnOf(r.hsn), mrpPerPackPaise: rupeesToPaise(r.mrp),
    });
  }
  return out;
}

/**
 * The catalogue rows whose BRAND is the vendor's brand: "Pan (pantoprazole…)", "Moxikind-CV (…)". The search
 * ranks generics and short names first, so a short brand ("Pan") can be buried under "Pantoprazole", "Panz",
 * "Panto"; this reads the brand stem directly — the words before the strength, a hyphen or a space between them.
 */
async function byBrandStem(db: Db, core: string): Promise<MedicineHit[]> {
  const words = core.split(" ").filter((w) => w !== "" && !/^\d/.test(w));
  if (words.length === 0 || words.join("").length < 2) return [];
  const pattern = `^${words.map((w) => w.replace(/[^a-z0-9]/g, "")).join("[- ]?")} \\(`;
  const rows = await db.select({ id: formularyMedicines.id, name: formularyMedicines.brandName, form: formularyMedicines.form, strength: formularyMedicines.strengthLabel, code: formularyMedicines.code, routeClass: formularyMedicines.routeClass })
    .from(formularyMedicines).where(sql`${formularyMedicines.active} and ${formularyMedicines.brandName} ~* ${pattern}`).limit(40);
  return rows.map((r) => ({ ...r, salts: [], prefix: true, reviewed: true }));
}

function hsnOf(text: string | undefined): string {
  const digits = (text ?? "").replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 8 ? digits : "3004";
}

export type ImportRow = {
  line: number; medicineId: string; brand: string; packType: PackType; packSize: number;
  gstRateBps: number; hsnCode: string; mrpPerPackPaise: number; storage: "ambient" | "cold_2_8";
};
export type ImportResult = { line: number; ok: true; itemId: string; code: string; name: string } | { line: number; ok: false; code: string; message: string };

/** Each ticked row through `createStockDrug` — the + New drug call, every guard and permission — one row at a time. */
export async function importPriceList(db: Db, actor: Actor, rows: readonly ImportRow[], now: Date = new Date()): Promise<ImportResult[]> {
  if (rows.length > MAX_ROWS) throw new PharmacyError("invalid_range", `at most ${String(MAX_ROWS)} items at a time`);
  const meds = await medicinesByIds(db, [...new Set(rows.map((r) => r.medicineId))]);
  const out: ImportResult[] = [];
  for (const r of rows) {
    const med = meds.get(r.medicineId);
    try {
      const made = await createStockDrug(db, actor, {
        brandName: med?.brandName ?? r.brand, strength: med?.strengthLabel ?? "", medicineId: r.medicineId, form: med?.form ?? "",
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
