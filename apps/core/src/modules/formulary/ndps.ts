import { and, eq, isNotNull, sql } from "drizzle-orm";
import { anyOfText } from "../../kernel/db/any-of";
import { formularyMedicineSalts, formularySalts } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { MAX_IDS } from "./reads";
import { updateSalt } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 — WHICH MOIETIES THE NDPS ACT CONTROLS (brief 2026-09-26, §2) ═══
 *
 * The NDPS Act 1985 lists NARCOTIC DRUGS by substance (s.2(xiv): coca, cannabis, opium, poppy straw and
 * the manufactured drugs; the opium derivatives of s.2(xvi)) and PSYCHOTROPIC SUBSTANCES in its Schedule
 * (s.2(xxiii)). A brand is controlled because it contains one of them, so the class is written on the
 * MOIETY (`formulary_salts.ndps_class`) and a medicine takes the strictest class among its moieties.
 *
 * The list below is the CITED list. Every entry names its source; a moiety not named here stays
 * unclassified (null) and the classification report lists every catalogue moiety whose name looks
 * controlled but is not on this list, for a pharmacist to decide — it is never guessed. Where the sources
 * could not be confirmed the stricter reading was taken and the brief says so.
 */
export type NdpsClass = "narcotic" | "psychotropic";
export const NDPS_CLASSES: readonly NdpsClass[] = ["narcotic", "psychotropic"];

export type NdpsEntry = { moiety: string; ndpsClass: NdpsClass; essential: boolean; source: string };

const END = "NDPS Act s.2(viiia); S.O. 1181(E), 5 May 2015 — an essential narcotic drug (NDPS Rules Ch. VA/VB, G.S.R. 359(E))";
const PETHIDINE = "NDPS Act s.2(xi)/(xiv) manufactured narcotic drug, not an essential one (s.10, State NDPS rules) — the stricter reading";
const TRAMADOL = "NDPS Act s.2(xxiii) psychotropic substance, Schedule entry 110Y (S.O. 1761(E), 26 April 2018)";

/**
 * The six essential narcotic drugs S.O. 1181(E) names (codeine AND ethylmorphine are one entry, two
 * moieties), pethidine, and tramadol. Nothing else: the benzodiazepines, buprenorphine, pentazocine and
 * ketamine ARE in the Act's psychotropic Schedule, but the entries were not read at their source, so they
 * are reported for a pharmacist to rule on rather than written here. S.O. 1181(E) excludes low-strength
 * codeine (≤100 mg a unit, ≤2.5% undivided) and morphine (≤0.2%) preparations; the catalogue cannot read
 * a concentration reliably, so every product of the moiety is controlled until a product exemption exists
 * (deferred) — the stricter reading.
 */
export const NDPS_LIST: readonly NdpsEntry[] = [
  { moiety: "morphine", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "fentanyl", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "methadone", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "oxycodone", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "hydrocodone", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "codeine", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "ethylmorphine", ndpsClass: "narcotic", essential: true, source: END },
  { moiety: "pethidine", ndpsClass: "narcotic", essential: false, source: PETHIDINE },
  { moiety: "tramadol", ndpsClass: "psychotropic", essential: false, source: TRAMADOL },
];

/** Words that make a moiety LOOK controlled — the report lists catalogue moieties matching one that the list does not name. */
const LOOKS_CONTROLLED = /(morph|fentan|codein|opi|pethid|meperid|tramad|bupren|pentazo|nalbuph|tapentad|keta|barbit|azepam|azolam|zolpid|zopic|methylphen|amphet|modafin|dextroprop|diphenox|opium)/i;

const RANK: Record<NdpsClass, number> = { narcotic: 2, psychotropic: 1 };

/** The strictest class of each medicine's moieties; a medicine with no classified moiety is absent. */
export async function ndpsClassByMedicine(db: Db | Tx, ids: readonly string[]): Promise<Map<string, NdpsClass>> {
  const wanted = [...new Set(ids)].filter((id) => id !== "");
  if (wanted.length > MAX_IDS) {
    throw new FormularyError("too_many_ids", `ndpsClassByMedicine: asked for ${String(wanted.length)} ids at once, and ${String(MAX_IDS)} is the limit`, { asked: wanted.length, limit: MAX_IDS });
  }
  const out = new Map<string, NdpsClass>();
  if (wanted.length === 0) return out;
  const rows = await db.select({ medicineId: formularyMedicineSalts.medicineId, ndpsClass: formularySalts.ndpsClass })
    .from(formularyMedicineSalts)
    .innerJoin(formularySalts, eq(formularySalts.id, formularyMedicineSalts.saltId))
    .where(and(anyOfText(formularyMedicineSalts.medicineId, wanted), isNotNull(formularySalts.ndpsClass)));
  for (const r of rows) {
    const c = r.ndpsClass as NdpsClass;
    const had = out.get(r.medicineId);
    if (had === undefined || RANK[c] > RANK[had]) out.set(r.medicineId, c);
  }
  return out;
}

export type NdpsClassificationReport = {
  /** Moieties the list named and the catalogue has, with the class written (or that would be, on a dry run). */
  classified: { saltId: string; name: string; ndpsClass: NdpsClass; was: string | null; essential: boolean; source: string }[];
  /** Already carried the listed class. */
  unchanged: number;
  /** Listed moieties the catalogue does not carry under that name — nothing to classify. */
  notInCatalogue: string[];
  /** Catalogue moieties that LOOK controlled and the list does not name — a pharmacist decides each; left null. */
  unknown: { saltId: string; name: string; ndpsClass: string | null }[];
};

/**
 * Writes the cited list onto the catalogue's moieties (by name, case-insensitively), through `updateSalt`
 * so each change is a `salt.updated` event. `apply: false` reports without writing. A moiety already
 * carrying a DIFFERENT class keeps it on a dry run and is reported; `apply` sets the list's class — the
 * list is the cited source.
 */
export async function classifyNdpsSalts(tx: Tx, actor: Actor, opts: { apply: boolean }): Promise<NdpsClassificationReport> {
  const names = NDPS_LIST.map((e) => e.moiety);
  const found = await tx.select({ id: formularySalts.id, name: formularySalts.name, ndpsClass: formularySalts.ndpsClass })
    .from(formularySalts)
    .where(sql`lower(${formularySalts.name}) in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
  const byName = new Map(found.map((f) => [f.name.toLowerCase(), f]));
  const report: NdpsClassificationReport = { classified: [], unchanged: 0, notInCatalogue: [], unknown: [] };
  for (const e of NDPS_LIST) {
    const row = byName.get(e.moiety);
    if (row === undefined) { report.notInCatalogue.push(e.moiety); continue; }
    if (row.ndpsClass === e.ndpsClass) { report.unchanged += 1; continue; }
    report.classified.push({ saltId: row.id, name: row.name, ndpsClass: e.ndpsClass, was: row.ndpsClass, essential: e.essential, source: e.source });
    if (opts.apply) await updateSalt(tx, actor, row.id, { ndpsClass: e.ndpsClass });
  }
  const listed = new Set(names);
  const suspects = await tx.select({ id: formularySalts.id, name: formularySalts.name, ndpsClass: formularySalts.ndpsClass })
    .from(formularySalts)
    .where(sql`${formularySalts.name} ~* ${LOOKS_CONTROLLED.source}`)
    .limit(500);
  report.unknown = suspects
    .filter((s) => !listed.has(s.name.toLowerCase()))
    .map((s) => ({ saltId: s.id, name: s.name, ndpsClass: s.ndpsClass }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return report;
}
