import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  formularyGenericSubstances, formularyGenerics, formularyReferenceLabels, formularyReferenceNames, formularySubstances,
} from "../../kernel/db/schema";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ReferenceSections } from "../../kernel/db/schema";

/**
 * #616 (decision 0051; plan 2026-10-07 §11) — US FDA DRUG LABELS AS A LABELLED REFERENCE LAYER.
 *
 * The text is the manufacturer's US label, public domain through openFDA (CC0). It is REFERENCE ONLY: it never feeds a
 * dose, a frequency or a safety check (safety stays on the curated interactions and allergy classes), and no prescription
 * is ever changed by it. The only reader is `referenceForGeneric`, and screens print "US FDA label · <product> ·
 * <effective date>" and "reference only — the US product may differ in strength, dose and approved use" over it.
 *
 * Loading (`importReferenceLabels`, `scripts/import-fda-labels.ts`): the coverage run's choice file (which label is best
 * for each US substance key, and which formulary substance names read as that key — salt stripping and the Indian/INN →
 * US synonym map already applied) plus the openFDA bulk label files as JSON lines. Dry run by default. A refresh adds new
 * keys, retires a key whose chosen label changed and inserts the new one, and never retires a key the file omits.
 */

export type ReferenceSectionName = keyof ReferenceSections;

/** openFDA label fields per reference section, in reading order (prescription format, then over-the-counter "Drug Facts"). */
const FIELDS: Record<ReferenceSectionName, readonly string[]> = {
  uses: ["indications_and_usage", "purpose"],
  directions: ["dosage_and_administration"],
  boxed_warning: ["boxed_warning"],
  warnings: [
    "warnings_and_cautions", "warnings", "precautions", "general_precautions", "do_not_use", "ask_doctor", "ask_doctor_or_pharmacist",
    "when_using", "stop_use", "keep_out_of_reach_of_children",
  ],
  contraindications: ["contraindications"],
  side_effects: ["adverse_reactions"],
  interactions: ["drug_interactions"],
  pregnancy: ["pregnancy", "teratogenic_effects", "pregnancy_or_breast_feeding"],
  lactation: ["lactation", "nursing_mothers"],
  children: ["pediatric_use"],
  elderly: ["geriatric_use"],
  overdose: ["overdosage"],
  storage: ["storage_and_handling", "how_supplied"],
  patient_information: ["information_for_patients", "patient_medication_information", "spl_patient_package_insert", "spl_medguide"],
};
export const REFERENCE_SECTIONS = Object.keys(FIELDS) as ReferenceSectionName[];

/** One openFDA label → its reference sections (verbatim text; a field's paragraphs joined by a blank line). Pure. */
export function referenceSectionsOf(label: Record<string, unknown>): ReferenceSections {
  const out: ReferenceSections = {};
  for (const name of REFERENCE_SECTIONS) {
    const parts = FIELDS[name].flatMap((f) => {
      const v = label[f];
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
    });
    if (parts.length > 0) out[name] = parts.join("\n\n");
  }
  return out;
}

const ChoiceSchema = z.object({
  status: z.string(),
  formulary_names: z.array(z.string()).optional(),
  label_id: z.string().min(1).optional(),
  set_id: z.string().optional(),
  version: z.string().optional(),
  effective_date: z.string().optional(),
  brand: z.string().nullable().optional(),
  tier: z.string().optional(),
  product_type: z.string().optional(),
});
const ChoicesSchema = z.object({
  substances: z.record(z.string(), ChoiceSchema),
  combinations: z.record(z.string(), ChoiceSchema).default({}),
});

export type ReferencePlanRow = {
  refKey: string; labelId: string; setId: string; version: string; product: string; productType: string | null;
  effectiveDate: string | null; matchTier: string | null; sections: ReferenceSections;
};
export type ReferencePlan = { rows: ReferencePlanRow[]; names: { name: string; refKey: string }[]; missing: string[] };

const isoOf = (yyyymmdd: unknown): string | null =>
  typeof yyyymmdd === "string" && /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : null;
const first = (v: unknown): string | null => (Array.isArray(v) && typeof v[0] === "string" && v[0].trim() !== "" ? v[0].trim() : null);

/**
 * Pure: the choice file and the label lines → the rows to hold, the name map, and the keys whose chosen label the files
 * do not contain (`missing`). A key is canonical: lower-case components, sorted, joined by " + ".
 */
export function planReferenceImport(choicesJson: string, labelsJsonl: string): ReferencePlan {
  const choices = ChoicesSchema.parse(JSON.parse(choicesJson));
  // One label may be the choice for SEVERAL keys (a combination product's label chosen for a component, two spellings
  // of one moiety): every key keeps its row, so the map holds a list per label id.
  const wanted = new Map<string, { refKey: string; choice: z.infer<typeof ChoiceSchema> }[]>();
  for (const [refKey, c] of [...Object.entries(choices.substances), ...Object.entries(choices.combinations)]) {
    const key = refKey.split(" + ").map((s) => s.trim().toLowerCase()).sort().join(" + ");
    if (c.label_id !== undefined) wanted.set(c.label_id, [...(wanted.get(c.label_id) ?? []).filter((w) => w.refKey !== key), { refKey: key, choice: c }]);
  }
  const rows: ReferencePlanRow[] = [];
  for (const line of labelsJsonl.split("\n")) {
    if (line.trim() === "") continue;
    const label = JSON.parse(line) as Record<string, unknown>;
    const id = typeof label.id === "string" ? label.id : "";
    const ws = wanted.get(id);
    if (ws === undefined) continue;
    wanted.delete(id); // a label repeated across the files is read once
    const openfda = (label.openfda ?? {}) as Record<string, unknown>;
    const sections = referenceSectionsOf(label);
    for (const w of ws) {
      rows.push({
        refKey: w.refKey, labelId: id, setId: typeof label.set_id === "string" ? label.set_id : (w.choice.set_id ?? ""),
        version: typeof label.version === "string" ? label.version : (w.choice.version ?? ""),
        product: first(openfda.brand_name) ?? (w.choice.brand?.trim() || null) ?? w.refKey,
        productType: first(openfda.product_type) ?? w.choice.product_type ?? null,
        effectiveDate: isoOf(label.effective_time) ?? isoOf(w.choice.effective_date), matchTier: w.choice.tier ?? null,
        sections,
      });
    }
  }
  const names = new Map<string, string>();
  for (const [refKey, c] of Object.entries(choices.substances)) {
    for (const n of c.formulary_names ?? []) names.set(n.trim().toLowerCase(), refKey.trim().toLowerCase());
  }
  return {
    rows: rows.sort((a, b) => a.refKey.localeCompare(b.refKey)),
    names: [...names].map(([name, refKey]) => ({ name, refKey })).sort((a, b) => a.name.localeCompare(b.name)),
    missing: [...wanted.values()].flatMap((ws) => ws.map((w) => w.refKey)).sort(),
  };
}

const ImportInput = z.object({
  choicesJson: z.string().min(2),
  labelsJsonl: z.string(),
  source: z.string().trim().min(1).max(200),
  retrievedOn: z.iso.date(),
  apply: z.boolean().default(false),
});

export type ReferenceImportResult = {
  applied: boolean; batch: string;
  labels: { added: number; changed: number; unchanged: number; missing: number };
  names: { added: number; changed: number; unchanged: number };
};

/**
 * Loads (or, without `apply`, only measures) a label refresh. A person runs it (the script); no screen and no seed calls it.
 * Each label row carries `source` and `retrievedOn`. A key whose chosen label id is unchanged is left alone.
 */
export async function importReferenceLabels(db: Db, actor: Actor, raw: unknown, at: Date = new Date()): Promise<ReferenceImportResult> {
  const input = ImportInput.parse(raw);
  const plan = planReferenceImport(input.choicesJson, input.labelsJsonl);
  const batch = newId();
  return withTx(db, async (tx) => {
    const live = new Map((await tx.select().from(formularyReferenceLabels)
      .where(and(eq(formularyReferenceLabels.source, input.source), isNull(formularyReferenceLabels.retiredAt))))
      .map((r) => [r.refKey, r] as const));
    const labels = { added: 0, changed: 0, unchanged: 0, missing: plan.missing.length };
    for (const r of plan.rows) {
      const cur = live.get(r.refKey);
      if (cur?.labelId === r.labelId) { labels.unchanged += 1; continue; }
      if (cur === undefined) labels.added += 1; else labels.changed += 1;
      if (!input.apply) continue;
      if (cur !== undefined) {
        await tx.update(formularyReferenceLabels).set({ retiredAt: at, retiredBy: actor.id }).where(eq(formularyReferenceLabels.id, cur.id));
      }
      await tx.insert(formularyReferenceLabels).values({
        id: newId(), source: input.source, retrievedOn: input.retrievedOn, refKey: r.refKey, labelId: r.labelId, setId: r.setId,
        version: r.version, product: r.product, productType: r.productType, effectiveDate: r.effectiveDate, matchTier: r.matchTier,
        sections: r.sections, importBatch: batch, importedBy: actor.id, importedAt: at,
      });
    }
    const held = new Map((await tx.select().from(formularyReferenceNames)).map((n) => [n.name, n.refKey] as const));
    const names = { added: 0, changed: 0, unchanged: 0 };
    for (const n of plan.names) {
      const cur = held.get(n.name);
      if (cur === n.refKey) { names.unchanged += 1; continue; }
      if (cur === undefined) names.added += 1; else names.changed += 1;
      if (!input.apply) continue;
      await tx.insert(formularyReferenceNames).values({ name: n.name, refKey: n.refKey, importBatch: batch, updatedBy: actor.id, updatedAt: at })
        .onConflictDoUpdate({ target: formularyReferenceNames.name, set: { refKey: n.refKey, importBatch: batch, updatedBy: actor.id, updatedAt: at } });
    }
    return { applied: input.apply, batch, labels, names };
  });
}

export type ReferenceEntry = {
  refKey: string; source: string; retrievedOn: string; product: string; productType: string | null; effectiveDate: string | null;
  setId: string; labelId: string; version: string; sections: ReferenceSections;
};
export type GenericReference = {
  genericSctid: string;
  /** `label`: the generic's own substance or combination has a label; `components`: a combination shown by its parts. */
  status: "label" | "components" | "none";
  combination: boolean;
  entries: ReferenceEntry[];
  /** The US substance keys (or, unmapped, the formulary names) with no label on file. */
  missing: string[];
};

const entryOf = (r: typeof formularyReferenceLabels.$inferSelect): ReferenceEntry => ({
  refKey: r.refKey, source: r.source, retrievedOn: r.retrievedOn, product: r.product, productType: r.productType, effectiveDate: r.effectiveDate,
  setId: r.setId, labelId: r.labelId, version: r.version, sections: r.sections,
});

/**
 * The reference for a generic (by SNOMED id): its own label (single substance or the exact combination), else each
 * component's label with the missing parts named, else `none`. `undefined` for an unknown generic. Reference only.
 */
export async function referenceForGeneric(db: Db | Tx, genericSctid: string): Promise<GenericReference | undefined> {
  const g = (await db.select({ id: formularyGenerics.id }).from(formularyGenerics).where(eq(formularyGenerics.sctid, genericSctid)))[0];
  if (g === undefined) return undefined;
  const subs = await db.select({ name: formularySubstances.name }).from(formularyGenericSubstances)
    .innerJoin(formularySubstances, eq(formularySubstances.id, formularyGenericSubstances.substanceId))
    .where(eq(formularyGenericSubstances.genericId, g.id));
  const lowered = [...new Set(subs.map((s) => s.name.trim().toLowerCase()))];
  const mapped = lowered.length === 0 ? [] : await db.select().from(formularyReferenceNames).where(inArray(formularyReferenceNames.name, lowered));
  const keyOf = new Map(mapped.map((m) => [m.name, m.refKey] as const));
  // One key per distinct US substance (two salts of one moiety read as one).
  const keys = [...new Set(lowered.map((n) => keyOf.get(n) ?? n))].sort();
  const combination = keys.length > 1;
  const lookup = [...new Set([...(combination ? [keys.join(" + ")] : []), ...keys])];
  const rows = lookup.length === 0 ? [] : await db.select().from(formularyReferenceLabels)
    .where(and(inArray(formularyReferenceLabels.refKey, lookup), isNull(formularyReferenceLabels.retiredAt)));
  const byKey = new Map<string, (typeof rows)[number]>();
  // Two sources may hold the same key: the newest retrieval first.
  for (const r of [...rows].sort((a, b) => b.retrievedOn.localeCompare(a.retrievedOn))) if (!byKey.has(r.refKey)) byKey.set(r.refKey, r);
  const own = byKey.get(keys.join(" + "));
  if (own !== undefined) return { genericSctid, status: "label", combination, entries: [entryOf(own)], missing: [] };
  const parts = combination ? keys.filter((k) => byKey.has(k)) : [];
  const missing = keys.filter((k) => !byKey.has(k));
  if (parts.length === 0) return { genericSctid, status: "none", combination, entries: [], missing };
  return { genericSctid, status: "components", combination, entries: parts.map((k) => entryOf(byKey.get(k)!)), missing };
}
