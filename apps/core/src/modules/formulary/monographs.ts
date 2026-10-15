/**
 * ═══ THE DRUG MONOGRAPH — WHAT A DRUG IS FOR, TOLD FOUR WAYS, AND READ ONLY ONCE REVIEWED (owner 2026-10-02) ═══
 *
 * The owner's Drug Information Service specification (v1.25) tells one generic four ways: to the patient
 * (plain-language uses, bilingual counselling, red flags), to the prescriber (indications, organ adjustments,
 * monitoring), to the ward nurse (tube administration, holds, dialysis) and to the counter (the Jan Aushadhi
 * benchmark). Those are prose, and they change as a document. They are kept as four JSON sections on one row
 * per generic — the specification's own shape — and nothing here interprets them.
 *
 * What is NOT kept here, on purpose:
 *   - stock, batches, prices, rack, pack sizes — the specification's `pharmacy_inventory_pos` is a VIEW of
 *     `items`, `stock_batches` and `stock_balances`, which already hold them as rows under the ledger's locks;
 *   - interactions, drug–disease and allergy classes — `formulary_interactions`, `formulary_drug_disease` and
 *     `formulary_salts.allergy_classes` already hold them, and the checks read those.
 *
 * THE RENAL BANDS ARE ROWS, because a check will one day compute on them (a clearance goes in, a dose comes
 * out), and a check cannot compute on a sentence. A band is `[crcl_min, crcl_max)` in mL/min: the lower bound
 * is inside the band and the upper bound is not, so 10 reads "10 to 25" and 25 reads "25 and above".
 *
 * ═══ THE GATE ═══
 *
 * The clinical master loaded in September filled every column for 10,303 generics with six to nine distinct
 * values each — class templates, some of them dangerous (plan P21, "not shown to clinicians"). So a monograph
 * is written as a DRAFT and no reader sees a draft: `getMonograph` returns nothing and `renalDoseFor` answers
 * null. A SECOND person reviews it (`monograph_same_actor` refuses the writer), and any later edit makes it a
 * draft again. The second pair of eyes is the only thing that makes this text safe to show.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { formularyGenerics, formularyMonographs, formularyRenalDoses } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { monographReviewed, monographSaved } from "./events";
import { normalizeDrugName } from "./resolve";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { MonographSection } from "../../kernel/db/schema";

export const RENAL_SEVERITIES = ["normal", "reduce", "avoid"] as const;
export type RenalSeverity = (typeof RENAL_SEVERITIES)[number];
export const MONOGRAPH_SECTIONS = ["patient", "prescriber", "nursing", "affordability"] as const;
export type MonographSectionName = (typeof MONOGRAPH_SECTIONS)[number];

export type RenalDoseInput = { crclMin: number | null; crclMax: number | null; dose: string; severity: RenalSeverity };
export type MonographInput = {
  genericSctid: string;
  /** The version of the source document this text was taken from ("1.25"). */
  sourceVersion: string;
  patient?: MonographSection | null;
  prescriber?: MonographSection | null;
  nursing?: MonographSection | null;
  affordability?: MonographSection | null;
  renalDoses?: RenalDoseInput[];
};

export type RenalDose = RenalDoseInput & { id: string; position: number };
export type Monograph = typeof formularyMonographs.$inferSelect & { renalDoses: RenalDose[] };

/** Bands ordered from the lowest clearance up; refuses a band with no bound, an inverted band and any overlap. */
function orderedBands(bands: readonly RenalDoseInput[]): RenalDoseInput[] {
  for (const b of bands) {
    if (b.crclMin === null && b.crclMax === null) throw new FormularyError("invalid_monograph", "a renal band needs a lower or an upper clearance bound");
    if (b.crclMin !== null && b.crclMax !== null && b.crclMin >= b.crclMax) {
      throw new FormularyError("invalid_monograph", `a renal band's lower bound (${String(b.crclMin)}) must be below its upper bound (${String(b.crclMax)})`);
    }
  }
  const sorted = [...bands].sort((a, b) => (a.crclMin ?? -1) - (b.crclMin ?? -1));
  for (let i = 1; i < sorted.length; i += 1) {
    const below = sorted[i - 1]!;
    const above = sorted[i]!;
    if (above.crclMin === null || below.crclMax === null || below.crclMax > above.crclMin) {
      throw new FormularyError("invalid_monograph", "renal bands must not overlap: each clearance reads exactly one dose");
    }
  }
  return sorted;
}

/**
 * Writes the monograph of one generic, whole: the sections passed replace the sections held (an omitted or
 * null section is stored as absent) and the renal bands are replaced as a set. The row becomes a DRAFT
 * written by `actor`, whatever it was before.
 */
export async function saveMonograph(tx: Tx, actor: Actor, input: MonographInput): Promise<{ monographId: string }> {
  const generic = (await tx.select({ id: formularyGenerics.id }).from(formularyGenerics).where(eq(formularyGenerics.sctid, input.genericSctid)))[0];
  if (generic === undefined) throw new FormularyError("unknown_generic", `no generic with SNOMED CT id ${input.genericSctid}`);
  const bands = orderedBands(input.renalDoses ?? []);

  const sections = {
    patient: input.patient ?? null, prescriber: input.prescriber ?? null,
    nursing: input.nursing ?? null, affordability: input.affordability ?? null,
  };
  const held = (await tx.select({ id: formularyMonographs.id }).from(formularyMonographs)
    .where(eq(formularyMonographs.genericId, generic.id)).for("update"))[0];
  const monographId = held?.id ?? newId();
  if (held === undefined) {
    await tx.insert(formularyMonographs).values({
      id: monographId, genericId: generic.id, sourceVersion: input.sourceVersion, ...sections,
      createdBy: actor.id, updatedBy: actor.id,
    });
  } else {
    await tx.update(formularyMonographs).set({
      sourceVersion: input.sourceVersion, ...sections, status: "draft", reviewedBy: null, reviewedAt: null,
      updatedBy: actor.id, updatedAt: new Date(),
    }).where(eq(formularyMonographs.id, monographId));
    await tx.delete(formularyRenalDoses).where(eq(formularyRenalDoses.monographId, monographId));
  }
  if (bands.length > 0) {
    await tx.insert(formularyRenalDoses).values(bands.map((b, position) => ({
      id: newId(), monographId, position, crclMin: b.crclMin, crclMax: b.crclMax, dose: b.dose, severity: b.severity,
    })));
  }
  await appendEvent(tx, monographSaved.make({
    payload: {
      monographId, genericId: generic.id, sourceVersion: input.sourceVersion,
      sections: MONOGRAPH_SECTIONS.filter((s) => sections[s] !== null), renalBands: bands.length,
    },
    actor, correlationId: monographId,
  }));
  return { monographId };
}

/** The second person's act. Refuses the person who last wrote the draft, and a monograph already reviewed. */
export async function reviewMonograph(tx: Tx, actor: Actor, monographId: string): Promise<void> {
  const row = (await tx.select().from(formularyMonographs).where(eq(formularyMonographs.id, monographId)).for("update"))[0];
  if (row === undefined) throw new FormularyError("unknown_monograph", `no monograph ${monographId}`);
  if (row.status === "reviewed") throw new FormularyError("monograph_already_reviewed", "this monograph is already reviewed; an edit makes it a draft again");
  if (row.updatedBy === actor.id) throw new FormularyError("monograph_same_actor", "the person who wrote a monograph cannot review it");
  await tx.update(formularyMonographs)
    .set({ status: "reviewed", reviewedBy: actor.id, reviewedAt: new Date() })
    .where(eq(formularyMonographs.id, monographId));
  await appendEvent(tx, monographReviewed.make({
    payload: { monographId, genericId: row.genericId, writtenBy: row.updatedBy }, actor, correlationId: monographId,
  }));
}

/**
 * The monograph of the generic with this SNOMED CT id. A draft is returned ONLY to a caller that asks for it
 * (`includeDraft`, the curation door); every other reader gets `undefined` for one.
 */
export async function getMonograph(db: Db | Tx, genericSctid: string, opts: { includeDraft?: boolean } = {}): Promise<Monograph | undefined> {
  const row = (await db.select({ monograph: formularyMonographs }).from(formularyMonographs)
    .innerJoin(formularyGenerics, eq(formularyGenerics.id, formularyMonographs.genericId))
    .where(eq(formularyGenerics.sctid, genericSctid)))[0]?.monograph;
  if (row === undefined) return undefined;
  if (row.status !== "reviewed" && opts.includeDraft !== true) return undefined;
  const bands = await db.select().from(formularyRenalDoses)
    .where(eq(formularyRenalDoses.monographId, row.id)).orderBy(asc(formularyRenalDoses.position));
  return {
    ...row,
    renalDoses: bands.map((b) => ({ id: b.id, position: b.position, crclMin: b.crclMin, crclMax: b.crclMax, dose: b.dose, severity: b.severity as RenalSeverity })),
  };
}

/**
 * The renal band a creatinine clearance (mL/min) falls in, from a REVIEWED monograph only. `null` when the
 * generic has no reviewed monograph or no band covers that clearance — "nothing reviewed says", never "normal".
 */
export async function renalDoseFor(db: Db | Tx, genericId: string, crclMlMin: number): Promise<RenalDose | null> {
  const bands = await db.select({ band: formularyRenalDoses }).from(formularyRenalDoses)
    .innerJoin(formularyMonographs, eq(formularyMonographs.id, formularyRenalDoses.monographId))
    .where(and(eq(formularyMonographs.genericId, genericId), eq(formularyMonographs.status, "reviewed")))
    .orderBy(asc(formularyRenalDoses.position));
  for (const { band: b } of bands) {
    if ((b.crclMin === null || crclMlMin >= b.crclMin) && (b.crclMax === null || crclMlMin < b.crclMax)) {
      return { id: b.id, position: b.position, crclMin: b.crclMin, crclMax: b.crclMax, dose: b.dose, severity: b.severity as RenalSeverity };
    }
  }
  return null;
}

export type GenericHit = { id: string; sctid: string; name: string; doseForm: string; monographStatus: "none" | "draft" | "reviewed" };

/**
 * The curation door's typeahead: active generics whose name contains what was typed (a name that STARTS with
 * it first), each with where its monograph stands. Fewer than two characters asks nothing. The 10,303
 * generics are scanned, not indexed, for the contains-match: this is one pharmacist's screen, not the consult.
 */
export async function searchGenerics(db: Db | Tx, q: string, limit = 10): Promise<GenericHit[]> {
  const norm = normalizeDrugName(q);
  if (norm.length < 2) return [];
  const escaped = norm.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db.select({
    id: formularyGenerics.id, sctid: formularyGenerics.sctid, name: formularyGenerics.name, doseForm: formularyGenerics.doseForm,
    status: formularyMonographs.status,
  }).from(formularyGenerics)
    .leftJoin(formularyMonographs, eq(formularyMonographs.genericId, formularyGenerics.id))
    .where(and(eq(formularyGenerics.active, true), sql`${formularyGenerics.nameNormalized} like ${`%${escaped}%`}`))
    .orderBy(desc(sql`${formularyGenerics.nameNormalized} like ${`${escaped}%`}`), asc(formularyGenerics.name), asc(formularyGenerics.id))
    .limit(Math.min(Math.max(limit, 1), 25));
  return rows.map((r) => ({
    id: r.id, sctid: r.sctid, name: r.name, doseForm: r.doseForm,
    monographStatus: r.status === "reviewed" ? "reviewed" : r.status === null ? "none" : "draft",
  }));
}
