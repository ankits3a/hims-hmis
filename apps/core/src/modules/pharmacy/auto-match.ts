import { and, eq, isNull } from "drizzle-orm";
import { pharmacyDispenseLines, pharmacyDispenses } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { MAX_IDS, medicinesByIds, normalizeDrugName, saltsByIds } from "../formulary";
import { availableQtyByItem, sellableBatchesByItem } from "../materials";
import { REFUSED_FLAGS, SCHEDULED_FLAGS } from "./config";
import { lineMatched } from "./events";
import { gstCategoryMap } from "./bill";
import { quoteItem } from "./quote";
import { shelfByMedicine } from "./shelf";
import { getDispenseRow, linesOf } from "./queue";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { MedicineWithSalts, SaltRow } from "../formulary";
import type { RxLine } from "../opd";

/**
 * ═══ A GENERIC PRESCRIPTION IS DISPENSED AS THE STOCKED BRAND OF THE SAME COMPOSITION ═══
 *
 * Found in production, 2026-09-23 (dispense 01M36QQXY3S0YBWAN7DQ9M31AJ): the doctor's lines came from
 * a CDS regimen template as GENERIC words — "Paracetamol Tablets 650mg", "Amoxicillin and Clavulanic
 * Acid 625mg", "Pantoprazole 40mg" — or as a formulary GENERIC ("Amoxicillin 200 mg oral tablet", a
 * clinical drug nobody stocks). The claim placed a line only when its medicine WAS a stocked item, so
 * every line opened with no item, no batch and no price, and nothing could be billed until the
 * pharmacist hand-chose all five. Filling a generic prescription with a brand of exactly that
 * composition is ordinary dispensing in an Indian hospital pharmacy, not a substitution: the doctor
 * named no product, so there is no product to substitute FOR.
 *
 * ═══ THE RULE (DECIDED 2026-09-23, standard Indian-corporate-hospital practice) ═══
 *
 * A line is matched only when the doctor did NOT name a brand — the words are free text, or they name
 * a formulary GENERIC (a clinical drug: the catalogue's rows that carry a D-code). A named brand is
 * never swapped here; that stays the consented substitution (`alternativesFor`, D6).
 *
 * The match is an EQUALITY, never a similarity: the SAME set of moieties (by salt id), the SAME amount
 * of each (per unit, or per mL for a liquid), and the same dose form and route —
 *   - an ordered generic: its form string exactly, and its route class;
 *   - free text: the form its words name ("tablet", "syrup", …), or — when they name none — an oral
 *     tablet or capsule for a per-unit strength and an oral liquid for a per-mL one. A release
 *     modifier the candidate carries (prolonged-release, dispersible, chewable, …) must be in the
 *     words too; gastro-resistant and film-coated are how the moiety is sold and are not asked for.
 *   - one strength for a combination ("Amoxicillin and Clavulanic Acid 625mg") is the Indian
 *     convention of naming the SUM (500 + 125) and is compared as one; otherwise each moiety's own.
 * No strength in the words, a moiety the shelf cannot name uniquely, or a composition it cannot read
 * → no match, and the line stays the amber "choose" row it always was. Schedule X is never matched.
 *
 * Among several matches: one with sellable stock (none → no match: a line that cannot be filled is
 * better left for a person), then the batch that expires first, then the lowest MRP per base unit,
 * then the item code — so the same shelf always gives the same answer.
 *
 * ═══ WHY THE BRAND NAME IS READ AND THE STORED STRENGTH IS NOT TRUSTED FOR A COMBINATION ═══
 *
 * Measured on the prod-like shelf: the CDS importer writes the PRODUCT's strength onto every moiety
 * row and into `strength_label`, so Augmentin DUO reads "500 mg" for amoxicillin AND for clavulanic
 * acid. The product NAME carries the truth ("(amoxicillin and clavulanate potassium) 500 mg + 125 mg
 * oral tablet"), so a combination's amounts are read from its name, in the order its moieties are
 * named; a single moiety's from its row. A combination whose name cannot be read is not matchable.
 *
 * ═══ THE CHECKS ARE THE ONES A CHOSEN LINE GETS ═══
 *
 * The match writes `dispensed_medicine_id` + `item_id` exactly where the claim's own text resolution
 * does (`substitution_type = 'resolved'`), so the pre-check and the verify re-run every book on the
 * matched medicine (D9) — nothing here decides safety. `dispense.line_matched` records what matched it
 * and on whose claim.
 */

export type Amount = { mg: number; per: "unit" | "ml" };

const MASS: Record<string, number> = { mg: 1, mcg: 0.001, "µg": 0.001, g: 1000, gm: 1000 };
const AMOUNT_RE = /(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*(mg|mcg|µg|gm|g)\b(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*ml\b)?/gi;

/** Every amount in a piece of text, per unit or per mL. `250 mg/5 mL`, `250/5 mg/ml`, `650mg`. */
export function amountsIn(text: string): Amount[] {
  const out: Amount[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const num = Number(m[1]);
    const unit = MASS[m[3]!.toLowerCase()]!;
    const hasMl = /ml\s*$/i.test(m[0]);
    // "250/5 mg/ml" — the ratio names the volume; "250 mg/5 mL" — the trailing volume does.
    const volume = m[2] !== undefined ? Number(m[2]) : m[4] !== undefined && m[4] !== "" ? Number(m[4]) : 1;
    if (!Number.isFinite(num) || !Number.isFinite(volume) || volume === 0) continue;
    out.push(hasMl || m[2] !== undefined ? { mg: (num * unit) / volume, per: "ml" } : { mg: num * unit, per: "unit" });
  }
  return out;
}

const COUNTER_IONS = new Set([
  "hydrochloride", "dihydrochloride", "hcl", "hydrobromide", "trihydrate", "dihydrate", "monohydrate", "anhydrous",
  "sodium", "potassium", "calcium", "magnesium", "sulfate", "sulphate", "maleate", "mesylate", "besylate", "besilate",
  "fumarate", "succinate", "tartrate", "citrate", "phosphate", "acetate", "bromide", "dipropionate", "propionate",
]);

/**
 * A moiety NAME reduced to what two spellings of one moiety share: the counter-ion dropped
 * ("montelukast sodium" → "montelukast") and an "-ate" anion read as its acid ("clavulanate" →
 * "clavulanic acid"). Applied to BOTH sides, and only ever consulted after an exact name/alias miss.
 */
export function moietyKey(raw: string): string {
  const words = raw.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w !== "");
  while (words.length > 1 && COUNTER_IONS.has(words[words.length - 1]!)) words.pop();
  if (words.length === 1 && words[0]!.endsWith("ate") && words[0]!.length > 5) return `${words[0]!.slice(0, -3)}ic acid`;
  return words.join(" ");
}

const FORM_WORDS: Record<string, string> = {
  tablet: "tablet", tablets: "tablet", tab: "tablet", tabs: "tablet",
  capsule: "capsule", capsules: "capsule", cap: "capsule", caps: "capsule",
  syrup: "syrup", syp: "syrup", suspension: "suspension", susp: "suspension",
  drops: "drops", drop: "drops", injection: "injection", inj: "injection",
  cream: "cream", ointment: "ointment", gel: "gel", lotion: "lotion", sachet: "sachet", powder: "powder",
};
/** Words a candidate's form may carry only if the prescription says them too. */
const MODIFIERS: Record<string, readonly string[]> = {
  prolonged: ["sr", "er", "xr", "cr", "pr", "prolonged", "sustained", "extended", "controlled"],
  extended: ["sr", "er", "xr", "cr", "pr", "prolonged", "sustained", "extended", "controlled"],
  sustained: ["sr", "er", "xr", "cr", "pr", "prolonged", "sustained", "extended", "controlled"],
  controlled: ["sr", "er", "xr", "cr", "pr", "prolonged", "sustained", "extended", "controlled"],
  modified: ["mr", "sr", "er", "xr", "cr", "modified"],
  dispersible: ["dt", "dispersible"], orodispersible: ["od", "odt", "orodispersible", "mouth"],
  chewable: ["chewable"], effervescent: ["effervescent"],
  rectal: ["rectal", "suppository"], vaginal: ["vaginal", "pessary"], sublingual: ["sublingual", "sl"],
  buccal: ["buccal"], ophthalmic: ["eye", "ophthalmic"], ear: ["ear", "otic"], nasal: ["nasal"],
  cutaneous: ["cutaneous", "topical"], injection: ["injection", "inj"], infusion: ["infusion"],
};
const NOISE = new Set([
  ...Object.keys(FORM_WORDS), "oral", "ip", "bp", "usp", "film", "coated", "gastro", "resistant", "enteric", "ec", "fc",
  "sr", "er", "xr", "cr", "mr", "dt", "od", "of", "for", "mg", "ml", "mcg", "g", "gm", "each", "strip", "conventional", "release",
]);

export type TextComposition = { names: string[]; amounts: Amount[]; sum: boolean; words: Set<string>; formWord: string | null };

/**
 * What the words say the medicine is MADE of. Null when they do not say it well enough to match
 * against: no moiety, no strength, or a count of strengths that fits neither "one each" nor "one sum".
 */
export function parseDrugText(text: string): TextComposition | null {
  const flat = text.toLowerCase().replace(/\(.*?\)/g, " ");
  const words = new Set(flat.replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w !== ""));
  const formWord = [...words].map((w) => FORM_WORDS[w]).find((f) => f !== undefined) ?? null;
  const segments = flat.split(/\s*\+\s*|\s+and\s+|\s+with\s+|\s*,\s*/).map((s) => s.trim()).filter((s) => s !== "");
  const names: string[] = [];
  const perSegment: Amount[][] = [];
  const loose: Amount[] = [];
  for (const seg of segments) {
    const amounts = amountsIn(seg);
    const name = seg.replace(AMOUNT_RE, " ").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w !== "" && !NOISE.has(w)).join(" ");
    if (name === "") { loose.push(...amounts); continue; }
    names.push(name);
    perSegment.push(amounts);
  }
  if (names.length === 0) return null;
  const all = [...perSegment.flat(), ...loose];
  if (perSegment.every((a) => a.length === 1) && loose.length === 0) return { names, amounts: perSegment.map((a) => a[0]!), sum: false, words, formWord };
  if (all.length === names.length) return { names, amounts: all, sum: false, words, formWord };
  if (all.length === 1 && names.length > 1) return { names, amounts: all, sum: true, words, formWord };
  return null;
}

type Candidate = {
  medicineId: string; itemId: string; itemCode: string; form: string; routeClass: string;
  scheduleFlag: string | null; amounts: Map<string, Amount>;
};

function sameAmount(a: Amount, b: Amount): boolean {
  return a.per === b.per && Math.abs(a.mg - b.mg) <= 1e-6 * Math.max(1, a.mg, b.mg);
}

/** A shelf medicine's moieties with each one's amount, or null when that cannot be read honestly. */
function amountsOf(m: MedicineWithSalts, salts: Map<string, SaltRow>): Map<string, Amount> | null {
  const out = new Map<string, Amount>();
  if (m.salts.length === 0) return null;
  if (m.salts.length === 1) {
    const only = m.salts[0]!;
    const a = amountsIn(only.strength ?? "")[0] ?? amountsIn(m.strengthLabel ?? "")[0] ?? amountsIn(m.brandName)[0];
    if (a === undefined) return null;
    out.set(only.saltId, a);
    return out;
  }
  // A combination: its NAME, "(a and b) 500 mg + 125 mg oral tablet", in the order the moieties are named.
  const named = /\(([^)]*)\)\s*(.*)$/.exec(m.brandName);
  if (named !== null) {
    const parts = named[1]!.split(/\s+and\s+|\s*\+\s*|\s*,\s*/).map((p) => p.trim()).filter((p) => p !== "");
    const amounts = amountsIn(named[2]!);
    if (parts.length === m.salts.length && amounts.length === parts.length) {
      for (const [i, part] of parts.entries()) {
        const hits = m.salts.filter((s) => {
          const row = salts.get(s.saltId);
          return row !== undefined && namesOf(row).some((n) => n === normalizeDrugName(part) || moietyKey(n) === moietyKey(part));
        });
        if (hits.length !== 1 || out.has(hits[0]!.saltId)) return null;
        out.set(hits[0]!.saltId, amounts[i]!);
      }
      return out;
    }
  }
  // A curated combination whose rows each carry their own strength; identical rows are the importer's copy, not a fact.
  const each = m.salts.map((s) => amountsIn(s.strength ?? "")[0]);
  if (each.some((a) => a === undefined)) return null;
  if (each.every((a) => sameAmount(a!, each[0]!))) return null;
  m.salts.forEach((s, i) => out.set(s.saltId, each[i]!));
  return out;
}

function namesOf(s: SaltRow): string[] {
  return [s.name, ...(s.aliases ?? [])].map(normalizeDrugName).filter((n) => n !== "");
}

/** The shelf, read once for a claim: what each sellable medicine is made of. */
export type ShelfIndex = {
  candidates: Candidate[];
  /** normalized name/alias → salt ids; moiety key → salt ids. Only the shelf's own moieties. */
  exact: Map<string, Set<string>>;
  keyed: Map<string, Set<string>>;
};

export async function shelfIndex(db: Db): Promise<ShelfIndex> {
  const shelf = await shelfByMedicine(db);
  const ids = [...shelf.keys()];
  const medicines = new Map<string, MedicineWithSalts>();
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    for (const [k, v] of await medicinesByIds(db, ids.slice(i, i + MAX_IDS))) medicines.set(k, v);
  }
  const saltIds = [...new Set([...medicines.values()].flatMap((m) => m.salts.map((s) => s.saltId)))];
  const salts = new Map<string, SaltRow>();
  for (let i = 0; i < saltIds.length; i += MAX_IDS) {
    for (const [k, v] of await saltsByIds(db, saltIds.slice(i, i + MAX_IDS))) salts.set(k, v);
  }
  const exact = new Map<string, Set<string>>();
  const keyed = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, k: string, id: string): void => {
    if (k === "") return;
    const set = map.get(k) ?? new Set<string>();
    set.add(id);
    map.set(k, set);
  };
  for (const s of salts.values()) {
    for (const n of namesOf(s)) { add(exact, n, s.id); add(keyed, moietyKey(n), s.id); }
  }
  const candidates: Candidate[] = [];
  for (const [medicineId, entry] of shelf) {
    const m = medicines.get(medicineId);
    if (m === undefined || !m.active) continue;
    if (m.scheduleFlag !== null && (REFUSED_FLAGS as readonly string[]).includes(m.scheduleFlag)) continue;
    const amounts = amountsOf(m, salts);
    if (amounts === null) continue;
    candidates.push({
      medicineId, itemId: entry.item.id, itemCode: entry.item.code, form: m.form, routeClass: m.routeClass,
      scheduleFlag: m.scheduleFlag, amounts,
    });
  }
  return { candidates, exact, keyed };
}

/** One of the shelf's moieties, or null when the name names none of them or more than one. */
function saltFor(ix: ShelfIndex, name: string): string | null {
  const exact = ix.exact.get(normalizeDrugName(name));
  if (exact !== undefined) return exact.size === 1 ? [...exact][0]! : null;
  const keyed = ix.keyed.get(moietyKey(name));
  return keyed !== undefined && keyed.size === 1 ? [...keyed][0]! : null;
}

function formFits(c: Candidate, t: TextComposition): boolean {
  const form = c.form.toLowerCase();
  const formWords = form.replace(/[^a-z\s]/g, " ").split(/\s+/);
  for (const w of formWords) {
    const needs = MODIFIERS[w];
    if (needs !== undefined && !needs.some((n) => t.words.has(n))) return false;
  }
  if (t.formWord !== null) return form.includes(t.formWord);
  const per = [...c.amounts.values()][0]?.per;
  const oral = form.includes("oral") || form.includes("tablet") || form.includes("capsule");
  if (!oral) return false;
  return per === "ml" ? /syrup|suspension|solution|liquid|drops/.test(form) : /tablet|capsule/.test(form);
}

export type MatchTarget =
  | { kind: "text"; text: string }
  | { kind: "generic"; medicine: MedicineWithSalts };

/** Every shelf medicine the target is made of exactly. Stock is not asked here. */
export function matchesFor(ix: ShelfIndex, target: MatchTarget): Candidate[] {
  const text = target.kind === "text" ? target.text : target.medicine.brandName;
  const parsed = parseDrugText(text);
  if (parsed === null) return [];
  const saltIds = parsed.names.map((n) => saltFor(ix, n));
  if (saltIds.some((s) => s === null) || new Set(saltIds).size !== saltIds.length) return [];
  const want = saltIds as string[];
  if (target.kind === "generic") {
    // The generic's own composition is the authority on WHICH moieties; the words only give amounts.
    const own = new Set(target.medicine.salts.map((s) => s.saltId));
    if (own.size !== want.length || want.some((s) => !own.has(s))) return [];
  }
  return ix.candidates.filter((c) => {
    if (c.amounts.size !== want.length || want.some((s) => !c.amounts.has(s))) return false;
    if (parsed.sum) {
      const pers = new Set([...c.amounts.values()].map((a) => a.per));
      const total = [...c.amounts.values()].reduce((n, a) => n + a.mg, 0);
      if (pers.size !== 1 || !sameAmount({ mg: total, per: [...pers][0]! }, parsed.amounts[0]!)) return false;
    } else if (want.some((s, i) => !sameAmount(c.amounts.get(s)!, parsed.amounts[i]!))) {
      return false;
    }
    if (target.kind === "generic") return c.form === target.medicine.form && c.routeClass === target.medicine.routeClass;
    return c.routeClass === "systemic" ? formFits(c, parsed) : parsed.formWord !== null && formFits(c, parsed);
  });
}

export type Matched = { medicineId: string; itemId: string; scheduleFlag: string | null; candidates: number };

/** The one to dispense: sellable stock, then first to expire, then lowest MRP per base unit, then code. */
export async function chooseMatch(db: Db, storeResourceId: string, found: Candidate[], now: Date): Promise<Matched | null> {
  if (found.length === 0) return null;
  const available = await availableQtyByItem(db, storeResourceId, found.map((c) => c.itemId), now);
  const stocked = found.filter((c) => (available.get(c.itemId) ?? 0) > 0);
  if (stocked.length === 0) return null;
  const batches = await sellableBatchesByItem(db, storeResourceId, stocked.map((c) => c.itemId), now);
  const gst = stocked.length > 1 ? await gstCategoryMap(db) : null;
  const ranked: { c: Candidate; expiry: string; mrp: number }[] = [];
  for (const c of stocked) {
    const first = (batches.get(c.itemId) ?? [])[0];
    const q = gst === null ? null : await quoteItem(db, gst, storeResourceId, c.itemId, now);
    ranked.push({ c, expiry: first?.expiryDate ?? "9999-12-31", mrp: q?.mrpUnitPaise ?? q?.unitPaise ?? Number.MAX_SAFE_INTEGER });
  }
  ranked.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.mrp - b.mrp || a.c.itemCode.localeCompare(b.c.itemCode));
  const best = ranked[0]!.c;
  return { medicineId: best.medicineId, itemId: best.itemId, scheduleFlag: best.scheduleFlag, candidates: found.length };
}

/** A line the doctor did not name a brand on: free words, or a formulary generic (a D-coded clinical drug). */
export function targetOf(rxLine: RxLine, ordered: MedicineWithSalts | undefined, placed: MedicineWithSalts | undefined): MatchTarget | null {
  if (ordered !== undefined) return ordered.code !== null ? { kind: "generic", medicine: ordered } : null;
  if (placed !== undefined) return placed.code !== null ? { kind: "generic", medicine: placed } : null;
  return rxLine.drug.trim() === "" ? null : { kind: "text", text: rxLine.drug };
}

export const MATCH_ACTOR: Actor = { type: "system", id: "pharmacy-match" };

/**
 * THE TICKETS ALREADY OPEN. A ticket claimed before this rule shipped (production's, 2026-09-23) has
 * its lines laid without items; when the pharmacist HOLDING it opens it, each still-unplaced line is
 * matched by the same rule. Idempotent: only a line with no item, no batch and no order is touched,
 * the UPDATE is conditional on exactly that, and a line matched once is never matched again.
 */
export async function matchOpenLines(db: Db, actor: Actor, dispenseId: string, now: Date, opts: { shelf?: () => Promise<ShelfIndex> } = {}): Promise<number> {
  const d = await getDispenseRow(db, dispenseId);
  if (d.status !== "claimed" || d.claimedBy !== actor.id || d.storeResourceId === null) return 0;
  const open = (await linesOf(db, dispenseId)).filter((l) => l.status === "open" && l.itemId === null && l.batchId === null && l.orderItemId === null);
  if (open.length === 0) return 0;
  const meds = await medicinesByIds(db, open.flatMap((l) => [l.orderedMedicineId, l.dispensedMedicineId]).filter((x): x is string => x !== null));
  const ix = await (opts.shelf ?? (() => shelfIndex(db)))();
  const matches: { line: (typeof open)[number]; m: Matched }[] = [];
  for (const l of open) {
    const target = targetOf(l.rxLine as RxLine, l.orderedMedicineId === null ? undefined : meds.get(l.orderedMedicineId), l.dispensedMedicineId === null ? undefined : meds.get(l.dispensedMedicineId));
    if (target === null) continue;
    const m = await chooseMatch(db, d.storeResourceId, matchesFor(ix, target), now);
    if (m !== null) matches.push({ line: l, m });
  }
  if (matches.length === 0) return 0;
  return withTx(db, async (tx) => {
    let n = 0;
    for (const { line, m } of matches) {
      const won = await tx.update(pharmacyDispenseLines)
        .set({ dispensedMedicineId: m.medicineId, itemId: m.itemId, substitutionType: "resolved", scheduleFlag: m.scheduleFlag ?? line.scheduleFlag })
        .where(and(eq(pharmacyDispenseLines.id, line.id), eq(pharmacyDispenseLines.status, "open"), isNull(pharmacyDispenseLines.itemId), isNull(pharmacyDispenseLines.orderItemId)))
        .returning({ id: pharmacyDispenseLines.id });
      if (won.length === 0) continue;
      n += 1;
      await appendEvent(tx, lineMatched.make({
        occurredAt: now, actor: MATCH_ACTOR, patientId: d.patientId, encounterId: d.encounterId, correlationId: d.id,
        payload: {
          dispenseId: d.id, lineIdx: line.lineIdx, patientId: d.patientId, orderedMedicineId: line.orderedMedicineId,
          dispensedMedicineId: m.medicineId, itemId: m.itemId, rule: "salt", candidates: m.candidates, onClaimOf: actor.id,
        },
      }));
    }
    if (matches.some((x) => x.m.scheduleFlag !== null && (SCHEDULED_FLAGS as readonly string[]).includes(x.m.scheduleFlag))) {
      await tx.update(pharmacyDispenses).set({ scheduled: true }).where(eq(pharmacyDispenses.id, d.id));
    }
    return n;
  });
}

/**
 * The desk's ticket read is POLLED, and a line no shelf medicine matches (production's levocetirizine +
 * ambroxol tablet) would otherwise re-read the shelf on every poll. The poll path reads it at most once
 * a minute; the claim always reads it fresh. A shelf edit is seen within the minute.
 */
export function cachedShelfIndex(db: () => Db, ttlMs = 60_000): () => Promise<ShelfIndex> {
  let at = 0;
  let held: Promise<ShelfIndex> | null = null;
  return () => {
    const t = Date.now();
    if (held === null || t - at > ttlMs) { at = t; held = shelfIndex(db()); held.catch(() => { held = null; }); }
    return held;
  };
}
