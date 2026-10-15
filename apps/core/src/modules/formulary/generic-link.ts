/**
 * ═══ A PRODUCT KNOWS ITS GENERIC (owner 2026-10-02) ═══
 *
 * The catalogue holds 103,383 product rows: 10,303 are a generic's own row (`source_ref` IS the generic's
 * SNOMED CT id) and the rest are brands (`source_ref` is the brand's own id). The bundle the brands came from
 * names each brand's generic, and the import never stored it. Every stocked drug item points at a BRAND row —
 * measured on the staging copy of production, 350 of 350 — so nothing at the counter could reach a generic's
 * monograph. `formulary_medicines.generic_sctid` is that missing link.
 *
 * It is the SNOMED CT id and not a foreign key to `formulary_generics.id`, for the reason `source_ref` is:
 * the two tables are filled by two imports (`import-cds-catalogue`, `import-nrces-formulary`) and the id both
 * know is the release's. A link naming a generic the formulary does not hold is refused here, not stored.
 *
 * `linkMedicinesToGenerics` only ever fills an EMPTY link: a link a person set is never overwritten by a
 * bundle, and a second run does nothing.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { formularyGenerics, formularyMedicines, formularyMonographs } from "../../kernel/db/schema";
import { getMonograph } from "./monographs";
import type { Db, Tx } from "../../kernel/db/client";
import type { MonographSection } from "../../kernel/db/schema";
import type { Monograph } from "./monographs";

export type GenericLinkReport = {
  /** Pairs the caller passed. */
  pairs: number;
  /** Brand rows whose empty link was filled from a pair. */
  linkedBrands: number;
  /** Generic product rows linked to themselves (`source_ref` is a generic's id). */
  linkedOwnRows: number;
  /** Distinct generic ids in the pairs that the formulary does not hold. Their brands stay unlinked. */
  unknownGeneric: number;
};

const CHUNK = 5_000;

/** Fills `generic_sctid` where it is empty: each generic's own row from its `source_ref`, each brand from its pair. */
export async function linkMedicinesToGenerics(
  tx: Tx, pairs: readonly { medicineSctid: string; genericSctid: string }[],
): Promise<GenericLinkReport> {
  const own = await tx.execute(sql`
    update formulary_medicines m set generic_sctid = m.source_ref
    where m.generic_sctid is null and exists (select 1 from formulary_generics g where g.sctid = m.source_ref)`);

  const wanted = [...new Set(pairs.map((p) => p.genericSctid))];
  const known = new Set<string>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const rows = await tx.execute<{ sctid: string }>(sql`
      select g.sctid from formulary_generics g
      where g.sctid in (select jsonb_array_elements_text(${JSON.stringify(chunk)}::jsonb))`);
    for (const r of rows.rows) known.add(r.sctid);
  }

  let linkedBrands = 0;
  const placeable = pairs.filter((p) => known.has(p.genericSctid));
  for (let i = 0; i < placeable.length; i += CHUNK) {
    const chunk = placeable.slice(i, i + CHUNK);
    const res = await tx.execute(sql`
      update formulary_medicines m set generic_sctid = p.generic_sctid
      from jsonb_to_recordset(${JSON.stringify(chunk.map((p) => ({ medicine_sctid: p.medicineSctid, generic_sctid: p.genericSctid })))}::jsonb)
        as p(medicine_sctid text, generic_sctid text)
      where m.source_ref = p.medicine_sctid and m.generic_sctid is null`);
    linkedBrands += res.rowCount ?? 0;
  }
  return { pairs: pairs.length, linkedBrands, linkedOwnRows: own.rowCount ?? 0, unknownGeneric: wanted.length - known.size };
}

/** The REVIEWED monograph of the generic this product is linked to; `undefined` when it has no link or no reviewed monograph. */
export async function monographForMedicine(db: Db | Tx, medicineId: string): Promise<Monograph | undefined> {
  const row = (await db.select({ genericSctid: formularyMedicines.genericSctid }).from(formularyMedicines).where(eq(formularyMedicines.id, medicineId)))[0];
  if (row === undefined || row.genericSctid === null) return undefined;
  return getMonograph(db, row.genericSctid);
}

/** What the counter tells the patient about a medicine: one or two sentences, in English and, when written, Hindi. */
export type Counselling = { en: string; hi: string | null };

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The counselling line inside a monograph's patient section. The section is kept as the specification wrote
 * it, so this reads the two places the specification puts the sentence, in order: the section's own
 * `counselling: { en, hi }`, then the FAQ whose `intent` is `how_to_take` (`answer_en`, `answer_hi`). Anything
 * else — a missing key, a wrong type, an empty string — is "nothing to say", never a guess.
 */
export function counsellingOf(patient: MonographSection | null): Counselling | null {
  if (patient === null) return null;
  const own = patient["counselling"];
  if (isRecord(own)) {
    const en = text(own["en"]);
    if (en !== null) return { en, hi: text(own["hi"]) };
  }
  const faqs = patient["plain_language_faqs"];
  if (Array.isArray(faqs)) {
    for (const f of faqs) {
      if (!isRecord(f) || f["intent"] !== "how_to_take") continue;
      const en = text(f["answer_en"]);
      if (en !== null) return { en, hi: text(f["answer_hi"]) };
    }
  }
  return null;
}

/** The counselling line of each of these products, from the REVIEWED monograph of the generic it is linked to. A product with none is absent from the map. */
export async function counsellingByMedicine(db: Db | Tx, medicineIds: string[]): Promise<Map<string, Counselling>> {
  if (medicineIds.length === 0) return new Map();
  const rows = await db.select({ medicineId: formularyMedicines.id, patient: formularyMonographs.patient })
    .from(formularyMedicines)
    .innerJoin(formularyGenerics, eq(formularyGenerics.sctid, formularyMedicines.genericSctid))
    .innerJoin(formularyMonographs, eq(formularyMonographs.genericId, formularyGenerics.id))
    .where(and(inArray(formularyMedicines.id, medicineIds), eq(formularyMonographs.status, "reviewed")));
  const out = new Map<string, Counselling>();
  for (const r of rows) {
    const c = counsellingOf(r.patient);
    if (c !== null) out.set(r.medicineId, c);
  }
  return out;
}
