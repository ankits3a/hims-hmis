import { and, eq, inArray } from "drizzle-orm";
import {
  formularyInteractions, formularyMedicineSalts, formularyMedicines, formularySalts,
} from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";

export type SaltRef = { saltId: string; moiety: string; drugClass: string | null };
export type ResolvedDrug = {
  medicineId: string | null;
  brandName: string | null;
  routeClass: "systemic" | "topical" | null;
  salts: SaltRef[];
};
export type InteractionPair = {
  saltAId: string; saltBId: string;
  severity: "severe" | "moderate"; note: string; routeScope: "systemic_only" | null;
};

/**
 * PLAN 16a T3 — the boundary `modules/opd` consumes (DD1: it imports these helpers and never these
 * tables).
 *
 * ═══ DD2 — FUZZY SUGGESTS, EXACT RESOLVES, AND THIS FILE IS THE "EXACT" HALF ═══
 *
 * The consult autocomplete (T6) may match generously: it is a picker, and a human confirms what it
 * offers. `resolveDrugTexts` is the opposite situation — it feeds the safety checks with NO human
 * in the loop, over allergy substances typed months ago and legacy free-text lines nobody is
 * looking at. A fuzzy match there does not produce a slightly-wrong suggestion; it attaches
 * ANOTHER DRUG'S MOIETIES to a line, and every check downstream then reasons confidently about a
 * medicine the patient is not taking. A wrong resolution is worse than no resolution, because no
 * resolution still gets the legacy substring layer and says so.
 *
 * So: normalized exact match only — brand name, then moiety name, then recorded alias. No
 * substring, no trigram, no edit distance, and no "did you mean". A typo resolves to `null`.
 *
 * ═══ WHY NORMALIZATION HAPPENS IN JS AND NOT IN THE WHERE CLAUSE ═══
 *
 * The obvious implementation filters in SQL — `where lower(brand_name) = $1`. It cannot work here
 * without writing the normalizer TWICE, once in TypeScript and once as a `regexp_replace` chain,
 * and §2.54 is the entry that says two copies of one fact drift by construction. The drift would
 * be silent and one-directional: a brand with a hyphen would resolve in one path and not the
 * other, and the half that stops resolving is the SAFETY half.
 *
 * The cost is that each call loads the active masters. That is deliberate and bounded by a fact
 * from the spec: the formulary stays *what-we-stock-sized* — hundreds of rows, not the tens of
 * thousands sitting in `formulary_staging` (which this path never reads). **The named extension
 * point, for the day that stops being true: a stored normalized column with a unique index, filled
 * by the SAME function, so there is still one normalizer and the WHERE clause reads a column
 * rather than re-deriving a value.**
 */

/**
 * Lowercase, strip `.,()-/`, collapse whitespace runs, trim. Idempotent.
 *
 * EXPORTED THROUGH `index.ts` BECAUSE `modules/opd/rx-checks.ts` NEEDS THE SAME ONE (T4). Its class
 * path compares an allergy substance to a moiety's drug class, and a second normalizer there would
 * be §2.54's defect in the worst possible place — the two copies that drifted would be the SAFETY
 * half and the curation half, silently.
 */
export function normalizeDrugName(raw: string): string {
  return raw.toLowerCase().replace(/[.,()\-/]/g, "").replace(/\s+/g, " ").trim();
}

type SaltRow = { id: string; name: string; aliases: string[]; drugClass: string | null };

async function activeSalts(db: Db): Promise<SaltRow[]> {
  const rows = await db.select({
    id: formularySalts.id, name: formularySalts.name,
    aliases: formularySalts.aliases, drugClass: formularySalts.drugClass,
  }).from(formularySalts).where(eq(formularySalts.active, true));
  return rows.map((r) => ({ ...r, aliases: r.aliases ?? [] }));
}

/**
 * Composition for a set of medicines — **every** moiety, active or not.
 *
 * ═══ C3, THE REVIEWER'S THIRD CRITICAL: `active` MEANS "NOT STOCKED", NEVER "NOT A SUBSTANCE" ═══
 *
 * This function used to filter the composition through `activeSalts()`. Deactivating one moiety —
 * an ordinary curation act, e.g. deduping `amoxycillin` into `amoxicillin`, which the `lower(name)`
 * index does NOT prevent — then emptied the composition of every live medicine containing it. The
 * medicine still resolved, so `resolution !== null`, so the line read as CHECKED and COVERED: zero
 * interaction hits, zero duplicate hits, and `unresolvedLineIndexes` empty. **The system reported
 * that it had checked and found nothing, having stopped checking.** That is the precise state the
 * header of this file calls "how a check suite silently stops checking", produced one screen below
 * the warning.
 *
 * A moiety's identity does not depend on whether the pharmacy currently stocks it. Standalone
 * resolution of a salt NAME still honours `active` (a deactivated moiety is not offered as a line
 * in its own right); what a medicine is MADE OF is not a stocking question.
 */
async function compositionOf(
  db: Db,
  medicineIds: string[],
  saltsById: Map<string, SaltRow>,
): Promise<Map<string, SaltRef[]>> {
  const out = new Map<string, SaltRef[]>();
  if (medicineIds.length === 0) return out;
  const rows = await db.select({
    medicineId: formularyMedicineSalts.medicineId, saltId: formularyMedicineSalts.saltId,
  }).from(formularyMedicineSalts).where(inArray(formularyMedicineSalts.medicineId, medicineIds));
  // Every referenced moiety, resolved from the WHOLE table rather than the active subset (C3).
  const referenced = [...new Set(rows.map((r) => r.saltId))];
  const allSalts = referenced.length === 0
    ? []
    : await db.select({
      id: formularySalts.id, name: formularySalts.name,
      aliases: formularySalts.aliases, drugClass: formularySalts.drugClass,
    }).from(formularySalts).where(inArray(formularySalts.id, referenced));
  const byId = new Map(allSalts.map((s) => [s.id, s]));
  for (const row of rows) {
    const salt = byId.get(row.saltId) ?? saltsById.get(row.saltId);
    // A composition row whose salt has been DELETED (not merely deactivated) is a broken reference
    // the schema's foreign key makes impossible; skipping is unreachable and safe.
    if (salt === undefined) continue;
    const list = out.get(row.medicineId) ?? [];
    list.push({ saltId: salt.id, moiety: salt.name, drugClass: salt.drugClass });
    out.set(row.medicineId, list);
  }
  return out;
}

function asRouteClass(raw: string): "systemic" | "topical" {
  // The column carries a CHECK constraint naming exactly these two, so anything else is a row that
  // could not have been stored. Treating an impossible value as systemic is the safe direction:
  // `systemic_only` interaction pairs then still apply.
  return raw === "topical" ? "topical" : "systemic";
}

/** Active medicines by id, each with its composition. An unknown or inactive id is simply absent. */
export async function resolveMedicines(db: Db, medicineIds: string[]): Promise<Map<string, ResolvedDrug>> {
  const out = new Map<string, ResolvedDrug>();
  const wanted = [...new Set(medicineIds)].filter((id) => id !== "");
  if (wanted.length === 0) return out;

  const medicines = await db.select({
    id: formularyMedicines.id, brandName: formularyMedicines.brandName,
    routeClass: formularyMedicines.routeClass,
  }).from(formularyMedicines).where(and(
    inArray(formularyMedicines.id, wanted),
    eq(formularyMedicines.active, true),
  ));
  if (medicines.length === 0) return out;

  const saltsById = new Map((await activeSalts(db)).map((s) => [s.id, s]));
  const composition = await compositionOf(db, medicines.map((m) => m.id), saltsById);
  for (const medicine of medicines) {
    out.set(medicine.id, {
      medicineId: medicine.id, brandName: medicine.brandName,
      routeClass: asRouteClass(medicine.routeClass),
      salts: composition.get(medicine.id) ?? [],
    });
  }
  return out;
}

/**
 * The DD2 path. Returns a map keyed by the CALLER'S OWN strings — a caller holding an allergy
 * substance or a free-text rx line looks the answer up by the text it passed, never by a
 * normalized form it would otherwise have to re-derive (and re-derive differently).
 *
 * `null` and an empty-salts drug are DIFFERENT ANSWERS and callers act on the difference: `null`
 * means "not in the formulary — use the legacy substring layer and say the advanced checks are
 * unavailable", while a resolved drug with no salts would mean "we know this medicine and it
 * contains nothing", which is how a check suite silently stops checking.
 */
export async function resolveDrugTexts(db: Db, texts: string[]): Promise<Map<string, ResolvedDrug | null>> {
  const out = new Map<string, ResolvedDrug | null>();
  if (texts.length === 0) return out;
  for (const text of texts) out.set(text, null);

  const wanted = new Set([...out.keys()].map(normalizeDrugName).filter((t) => t !== ""));
  if (wanted.size === 0) return out;

  const salts = await activeSalts(db);
  const saltsById = new Map(salts.map((s) => [s.id, s]));

  /** normalized moiety name → salt, and normalized alias → salt. Names win over aliases. */
  const byMoiety = new Map<string, SaltRow>();
  const byAlias = new Map<string, SaltRow>();
  for (const salt of salts) {
    byMoiety.set(normalizeDrugName(salt.name), salt);
    for (const alias of salt.aliases) {
      const key = normalizeDrugName(alias);
      if (key !== "" && !byAlias.has(key)) byAlias.set(key, salt);
    }
  }

  const medicines = await db.select({
    id: formularyMedicines.id, brandName: formularyMedicines.brandName,
    routeClass: formularyMedicines.routeClass,
  }).from(formularyMedicines).where(eq(formularyMedicines.active, true));
  const byBrand = new Map(medicines.map((m) => [normalizeDrugName(m.brandName), m]));

  const hitMedicineIds = [...wanted].map((t) => byBrand.get(t)?.id).filter((id): id is string => id !== undefined);
  const composition = await compositionOf(db, hitMedicineIds, saltsById);

  for (const text of out.keys()) {
    const key = normalizeDrugName(text);
    if (key === "") continue;

    // 1. brand — the only path that carries a composition.
    const medicine = byBrand.get(key);
    if (medicine !== undefined) {
      out.set(text, {
        medicineId: medicine.id, brandName: medicine.brandName,
        routeClass: asRouteClass(medicine.routeClass),
        salts: composition.get(medicine.id) ?? [],
      });
      continue;
    }
    // 2. moiety name, then 3. recorded alias. Both answer with the moiety alone: the text named a
    //    substance, not a product, so there is no brand and no route to report.
    const salt = byMoiety.get(key) ?? byAlias.get(key);
    if (salt !== undefined) {
      out.set(text, {
        medicineId: null, brandName: null, routeClass: null,
        salts: [{ saltId: salt.id, moiety: salt.name, drugClass: salt.drugClass }],
      });
    }
    // 4. nothing else. No substring, no distance — the entry stays `null` (DD2).
  }
  return out;
}

/**
 * Active pairs whose BOTH moieties are in `saltIds`.
 *
 * Both, not either: a pair is a fact about two drugs being present together, and returning the
 * ones with a single side present would hand the check engine hits it must then filter — a filter
 * that, forgotten, warns a patient about a drug they are not taking.
 */
export async function listInteractionsAmong(db: Db, saltIds: string[]): Promise<InteractionPair[]> {
  const wanted = [...new Set(saltIds)].filter((id) => id !== "");
  if (wanted.length < 2) return [];
  const rows = await db.select({
    saltAId: formularyInteractions.saltAId, saltBId: formularyInteractions.saltBId,
    severity: formularyInteractions.severity, note: formularyInteractions.note,
    routeScope: formularyInteractions.routeScope,
  }).from(formularyInteractions).where(and(
    eq(formularyInteractions.active, true),
    inArray(formularyInteractions.saltAId, wanted),
    inArray(formularyInteractions.saltBId, wanted),
  ));
  return rows.map((r) => ({
    saltAId: r.saltAId, saltBId: r.saltBId,
    severity: r.severity === "moderate" ? "moderate" : "severe",
    note: r.note,
    routeScope: r.routeScope === "systemic_only" ? "systemic_only" : null,
  }));
}
