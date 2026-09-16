import { and, eq, sql } from "drizzle-orm";
import {
  formularyInteractions, formularyMedicineSalts, formularyMedicines, formularySalts,
} from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";
import { anyOfText } from "../../kernel/db/any-of";

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
 * ═══ A MAPPED RELEASE ENTRY ALSO NAMES THE MOIETY IT WAS MAPPED TO (formulary phase 2) ═══
 *
 * A pharmacist's decision re-points DERIVED composition rows from a release entry to a moiety
 * (`mapping.ts`). Two things still name the entry itself after that:
 *   - a TEXT: an allergy recorded as "Amoxicillin trihydrate" resolves, by exact name, to the entry;
 *   - a medicine a pharmacist COMPOSED BY HAND from the entry, which no projection touches.
 * Left alone, the first stops matching the products that moved: no shared id, no class, no
 * substring. So an allergy check that was firing went silent BECAUSE of the decision. The second
 * never gains the moiety's class.
 *
 * So wherever the entry is named, the moiety it was mapped to is named beside it: both, never a
 * swap. It is the C1/C2 union's reasoning, and the direction is the same. A check that over-warns
 * costs a reasoned override; one that misses costs a patient. Not filtered by `active`, for C3's
 * reason below: identity is not a stocking question.
 *
 * `refs` are salt ids already resolved. Returns entry id → the moiety it names, for those that are
 * mapped entries only.
 */
async function mappedMoieties(db: Db, saltIds: string[]): Promise<Map<string, SaltRef>> {
  const out = new Map<string, SaltRef>();
  if (saltIds.length === 0) return out;
  const res = await db.execute<{ entry_id: string; id: string; name: string; drug_class: string | null }>(sql`
    select entry.id as entry_id, m.id, m.name, m.drug_class
      from formulary_salts entry
      join formulary_substances sub on sub.sctid = entry.source_ref and sub.mapping_status = 'mapped'
      join formulary_salts m on m.id = sub.salt_id
     where entry.id = any(${sql.param([...new Set(saltIds)])}::text[])
       and m.id <> entry.id
  `);
  for (const r of res.rows) out.set(r.entry_id, { saltId: r.id, moiety: r.name, drugClass: r.drug_class });
  return out;
}

/** Each list, with every mapped entry's moiety appended once. Order is kept: the entry, then its moiety. */
function withMapped(refs: SaltRef[], mapped: Map<string, SaltRef>): SaltRef[] {
  const out: SaltRef[] = [];
  const seen = new Set<string>();
  const push = (ref: SaltRef): void => { if (!seen.has(ref.saltId)) { seen.add(ref.saltId); out.push(ref); } };
  for (const ref of refs) {
    push(ref);
    const moiety = mapped.get(ref.saltId);
    if (moiety !== undefined) push(moiety);
  }
  return out;
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
): Promise<Map<string, SaltRef[]>> {
  const out = new Map<string, SaltRef[]>();
  if (medicineIds.length === 0) return out;
  const rows = await db.select({
    medicineId: formularyMedicineSalts.medicineId, saltId: formularyMedicineSalts.saltId,
  }).from(formularyMedicineSalts).where(anyOfText(formularyMedicineSalts.medicineId, medicineIds));
  // Every referenced moiety, resolved from the WHOLE table rather than the active subset (C3).
  const referenced = [...new Set(rows.map((r) => r.saltId))];
  const allSalts = referenced.length === 0
    ? []
    : await db.select({
      id: formularySalts.id, name: formularySalts.name,
      aliases: formularySalts.aliases, drugClass: formularySalts.drugClass,
    }).from(formularySalts).where(anyOfText(formularySalts.id, referenced));
  const byId = new Map(allSalts.map((s) => [s.id, s]));
  for (const row of rows) {
    const salt = byId.get(row.saltId);
    /*
      UNREACHABLE, AND THE REASON IS LOCAL RATHER THAN A FOREIGN KEY. `byId` is built four lines up
      from `formulary_salts where id = any(referenced)` with NO `active` filter, and `referenced` IS
      the distinct set of salt ids just read from the composition — so every key in this loop is
      covered by construction. `Map.get` is typed `| undefined`, which is why the branch is written
      at all. (The foreign key says the same thing more weakly: it is `NO ACTION`, and a count of
      composition rows whose salt is absent is 0 over the 142,759 on the loaded catalogue.)

      IT USED TO FALL BACK to an `activeSalts()` map passed in by the caller, and that arm was worse
      than unreachable: the map is ACTIVE-ONLY, a strict subset of what `byId` already holds, and it
      was read EARLIER — so in the only race that could have reached it, it answered with staler
      data than the lookup it was "backing". Deleting it removed a full 3,283-row read of
      `formulary_salts` from `resolveMedicines`, which runs on every prescription check.
    */
    if (salt === undefined) continue;
    const list = out.get(row.medicineId) ?? [];
    list.push({ saltId: salt.id, moiety: salt.name, drugClass: salt.drugClass });
    out.set(row.medicineId, list);
  }
  const mapped = await mappedMoieties(db, referenced);
  if (mapped.size > 0) {
    for (const [medicineId, list] of out) out.set(medicineId, withMapped(list, mapped));
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
    anyOfText(formularyMedicines.id, wanted),
    eq(formularyMedicines.active, true),
  ));
  if (medicines.length === 0) return out;

  const composition = await compositionOf(db, medicines.map((m) => m.id));
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

  /* `activeSalts` is EARNED here and only here: `byMoiety`/`byAlias` below are built from it, which
     is the DD2 resolution path. It is no longer read by `resolveMedicines`, so the dispensing gate's
     two-medicine call no longer pays for the whole moiety table. */
  const salts = await activeSalts(db);

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

  /*
    ASK FOR THE NAMES WANTED, NOT FOR THE CATALOGUE. This used to read every active medicine —
    measured at 103,383 rows on the loaded national catalogue, on EVERY prescription issue and every
    claim — and then normalize each brand in JavaScript to build a lookup map. The normalized key is
    stored now, so the set of texts the caller asked about goes into the WHERE clause instead.

    `normalizeDrugName` is still called exactly ONCE in TypeScript, on the caller's texts, at
    `wanted` above. The column holds what the same function produced at write time. That is the
    arrangement this file's header asks for: one normalizer, and a WHERE clause that reads a column
    rather than re-deriving a value.
  */
  const medicines = await db.select({
    id: formularyMedicines.id, brandName: formularyMedicines.brandName,
    routeClass: formularyMedicines.routeClass, nameNormalized: formularyMedicines.nameNormalized,
  }).from(formularyMedicines).where(and(
    eq(formularyMedicines.active, true),
    anyOfText(formularyMedicines.nameNormalized, [...wanted]),
  ));
  /*
    KEYED OFF THE STORED COLUMN, not off a re-normalized brand name. Keying off the latter would
    make this map agree with itself while disagreeing with the WHERE clause that filled it, and the
    disagreement would be invisible: a row would arrive and then fail to be found.

    ═══ A NAME TWO PRODUCTS SHARE RESOLVES TO THEIR MOIETIES, AND TO NO PRODUCT ═══

    51 normalized names collide on the loaded catalogue (`Ab-Xone` / `Abxone`). This used to keep the
    LAST row, and that row's id became the DISPENSED medicine for a free-typed line at the pharmacy
    counter (`pharmacy/claim.ts`, `substitutionType: "resolved"`). 6 of the 51 differ in strength,
    form or route, so the server was choosing which product the doctor meant. DD2 (exact only) and
    FD-35 (a guard, not a correction) decide it. The text exactly names SEVERAL products, so:
      - `medicineId`/`brandName` are null: no product is resolved, and the counter asks a person;
      - `salts` are the UNION of theirs: every check still fires, and if the products ever differ in
        composition the union is the conservative answer (C1/C2);
      - `routeClass` is systemic if ANY of them is, because a topical guess suppresses warnings.
    `test/formulary-mapping-safety.test.ts` pins all three.
  */
  const byBrand = new Map<string, typeof medicines>();
  for (const m of medicines) byBrand.set(m.nameNormalized, [...(byBrand.get(m.nameNormalized) ?? []), m]);

  const hitMedicineIds = [...wanted].flatMap((t) => (byBrand.get(t) ?? []).map((m) => m.id));
  const composition = await compositionOf(db, hitMedicineIds);

  for (const text of out.keys()) {
    const key = normalizeDrugName(text);
    if (key === "") continue;

    // 1. brand — the only path that carries a composition.
    const named = byBrand.get(key) ?? [];
    const [medicine] = named;
    if (named.length === 1 && medicine !== undefined) {
      out.set(text, {
        medicineId: medicine.id, brandName: medicine.brandName,
        routeClass: asRouteClass(medicine.routeClass),
        salts: composition.get(medicine.id) ?? [],
      });
      continue;
    }
    if (named.length > 1) {
      const union: SaltRef[] = [];
      const seen = new Set<string>();
      for (const m of named) {
        for (const ref of composition.get(m.id) ?? []) {
          if (!seen.has(ref.saltId)) { seen.add(ref.saltId); union.push(ref); }
        }
      }
      out.set(text, {
        medicineId: null, brandName: null,
        routeClass: named.some((m) => asRouteClass(m.routeClass) === "systemic") ? "systemic" : "topical",
        salts: union,
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

  // A name that resolved to a mapped release entry also names its moiety (`mappedMoieties`).
  const namedSalts = [...out.values()]
    .filter((r): r is ResolvedDrug => r !== null && r.medicineId === null && r.brandName === null && r.routeClass === null)
    .flatMap((r) => r.salts.map((s) => s.saltId));
  const mapped = await mappedMoieties(db, namedSalts);
  if (mapped.size > 0) {
    for (const [text, r] of out) {
      if (r !== null && r.medicineId === null && r.brandName === null && r.routeClass === null) {
        out.set(text, { ...r, salts: withMapped(r.salts, mapped) });
      }
    }
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
    anyOfText(formularyInteractions.saltAId, wanted),
    anyOfText(formularyInteractions.saltBId, wanted),
  ));
  return rows.map((r) => ({
    saltAId: r.saltAId, saltBId: r.saltBId,
    severity: r.severity === "moderate" ? "moderate" : "severe",
    note: r.note,
    routeScope: r.routeScope === "systemic_only" ? "systemic_only" : null,
  }));
}
