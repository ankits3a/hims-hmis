import { referenceSectionsOf } from "./reference-labels";
import type { DraftSourceInput } from "./crk-formulary";
import type { ReferenceSections } from "../../kernel/db/schema";

/**
 * ═══ #883 — FETCHERS FOR THE CRK FORMULARY'S PUBLIC SOURCES (decision 0053, spec docs/specs/883-crk-formulary-drafting.md) ═══
 *
 * The #618 drafter drafts only from the texts it is handed. These fetchers hand it texts the hospital may use, each as
 * its own source with the original database and its licence in the title, so the Pharmacology reviewer sees both:
 *
 *   - openFDA drug labels — public domain (CC0). The single-ingredient label is chosen (prescription before OTC, the
 *     richest, then the newest). Its dosing and overdose sections are never sent: the model never states a dose.
 *   - PubChem annotations, kept only where the original source is a US federal work: LiverTox and LactMed (US NLM),
 *     MeSH pharmacological classes (US NLM), FDA Pharm Classes (US FDA). Everything else PubChem carries is dropped —
 *     DrugBank, ChEMBL, StatPearls, WHO, HMDB, T3DB by their terms, and HSDB because its excerpts quote papers whose
 *     copyright stays with the publishers.
 *   - NHS, EMA and Medsafe are not fetched: the NHS key for a non-UK organisation is unverified (decision 0052), and
 *     EMA/Medsafe publish PDFs this job does not read yet.
 *
 * Nothing here touches the database or a model; `fetch` is injected so a test never reaches the network.
 */

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type SourceDeps = { fetch: FetchLike; retrievedOn: string };

/** At most this many sources per draft (the draft route's own limit). */
export const CRK_MAX_SOURCES = 8;
const SECTION_MAX = 2_500;
const PUBCHEM_SOURCE_MAX = 6_000;

/** Indian / INN names that the US label calls something else (openFDA searches US names). */
const US_NAMES: Record<string, string> = {
  paracetamol: "acetaminophen", salbutamol: "albuterol", levosalbutamol: "levalbuterol", adrenaline: "epinephrine",
  noradrenaline: "norepinephrine", frusemide: "furosemide", lignocaine: "lidocaine", glibenclamide: "glyburide",
  aciclovir: "acyclovir", valaciclovir: "valacyclovir", rifampicin: "rifampin", cefalexin: "cephalexin",
  "acetylsalicylic acid": "aspirin", pethidine: "meperidine", hyoscine: "scopolamine", thyroxine: "levothyroxine",
  "levothyroxine sodium": "levothyroxine", phenobarbitone: "phenobarbital", ciclosporin: "cyclosporine",
  benzylpenicillin: "penicillin g", phenoxymethylpenicillin: "penicillin v",
  chlorphenamine: "chlorpheniramine", isoprenaline: "isoproterenol", oxetacaine: "oxethazaine", amoxycillin: "amoxicillin",
  dicycloverine: "dicyclomine", "sodium valproate": "valproate sodium", mesalazine: "mesalamine", oestradiol: "estradiol",
  "glyceryl trinitrate": "nitroglycerin", tetracosactide: "cosyntropin",
  benflumetol: "lumefantrine", "alpha-glyceryl guaiacol ether": "guaifenesin", "aluminium hydroxide": "aluminum hydroxide",
  algeldrate: "aluminum hydroxide", dimeticone: "simethicone", "activated dimethicone": "simethicone",
};

/** Salt and ester words a label search does not need: "amlodipine besilate" is looked up as amlodipine. */
const SALT_WORDS = new Set([
  "hydrochloride", "hcl", "dihydrochloride", "hydrobromide", "sulfate", "sulphate", "besilate", "besylate", "maleate",
  "mesylate", "mesilate", "tartrate", "bitartrate", "citrate", "succinate", "fumarate", "acetate", "phosphate",
  "sodium", "potassium", "calcium", "magnesium", "disodium", "monohydrate", "dihydrate", "trihydrate", "anhydrous",
  "bromide", "nitrate", "lactate", "gluconate", "propionate", "dipropionate", "valerate", "furoate", "pamoate",
  "embonate", "hyclate", "palmitate", "stearate", "tosylate", "xinafoate", "aspartate", "base",
]);

/**
 * The plain name of a substance as the catalogue spells it: no "(substance)" tag, no "(as …)" note, no trailing salt
 * words ("Amlodipine besilate (substance)" → "amlodipine"). A name that is only salt words is kept whole.
 */
export function plainSubstanceName(substance: string): string {
  const n = substance.toLowerCase().replace(/\((?:substance|as [^)]*)\)/g, " ").replace(/\s+/g, " ").trim();
  if (US_NAMES[n] !== undefined) return n;
  const words = n.split(" ");
  while (words.length > 1 && SALT_WORDS.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

/** The US name openFDA knows a substance by. */
export function usNameOf(substance: string): string {
  const n = plainSubstanceName(substance);
  return US_NAMES[n] ?? n;
}

/** The label sections sent to the model, in reading order. Dosing (`directions`) and `overdose` are never sent. */
const FDA_SECTIONS: readonly (keyof ReferenceSections)[] = [
  "uses", "boxed_warning", "contraindications", "warnings", "side_effects", "interactions", "pregnancy", "lactation",
  "children", "elderly", "storage", "patient_information",
];

type Label = { set_id?: string; effective_time?: string; openfda?: { generic_name?: string[]; brand_name?: string[]; substance_name?: string[]; product_type?: string[] } } & Record<string, unknown>;

const isoDate = (yyyymmdd: string | undefined): string | null =>
  yyyymmdd !== undefined && /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : null;

/** One ingredient, and it is this substance (the salt may differ: "METFORMIN HYDROCHLORIDE" is metformin). */
function isSingleOf(label: Label, us: string): boolean {
  const subs = label.openfda?.substance_name ?? [];
  const names = label.openfda?.generic_name ?? [];
  if (subs.length > 1) return false;
  const name = (names[0] ?? subs[0] ?? "").toLowerCase();
  if (name === "" || /,|\band\b|\//.test(name)) return false;
  return name === us || name.startsWith(`${us} `);
}

/** The best single-ingredient label in an openFDA search answer, or null. Pure. */
export function chooseOpenFdaLabel(answer: unknown, substance: string): Label | null {
  const results = (answer as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  const us = usNameOf(substance);
  const singles = (results as Label[]).filter((l) => typeof l === "object" && l !== null && isSingleOf(l, us));
  if (singles.length === 0) return null;
  const rank = (l: Label): [number, number, string] => {
    const rx = (l.openfda?.product_type ?? []).includes("HUMAN PRESCRIPTION DRUG") ? 1 : 0;
    const sections = referenceSectionsOf(l);
    const rich = FDA_SECTIONS.filter((s) => sections[s] !== undefined).length;
    return [rx, rich, l.effective_time ?? ""];
  };
  return [...singles].sort((a, b) => {
    const [ra, sa, ea] = rank(a);
    const [rb, sb, eb] = rank(b);
    return rb - ra || sb - sa || eb.localeCompare(ea);
  })[0]!;
}

/** A chosen label → one `openfda` source. Pure. */
export function openFdaSourceOf(label: Label, ref: string): DraftSourceInput | null {
  const sections = referenceSectionsOf(label);
  const parts = FDA_SECTIONS.flatMap((s) => {
    const t = sections[s];
    return t === undefined ? [] : [`## ${s}\n${t.length > SECTION_MAX ? `${t.slice(0, SECTION_MAX)} …` : t}`];
  });
  if (parts.length === 0) return null;
  const product = label.openfda?.brand_name?.[0] ?? label.openfda?.generic_name?.[0] ?? "label";
  const setId = label.set_id ?? "";
  return {
    ref, kind: "openfda",
    title: `US FDA label · ${product} · licence: public domain (openFDA, CC0)`,
    url: setId === "" ? null : `https://api.fda.gov/drug/label.json?search=set_id:${setId}`,
    asOf: isoDate(label.effective_time),
    text: parts.join("\n\n"),
  };
}

export function openFdaSearchUrl(substance: string): string {
  return `https://api.fda.gov/drug/label.json?search=openfda.generic_name:${encodeURIComponent(`"${usNameOf(substance)}"`)}&limit=25`;
}

/** The openFDA source for one substance, or null (no single-ingredient label, or openFDA said no). */
export async function fetchOpenFdaSource(substance: string, ref: string, deps: SourceDeps): Promise<DraftSourceInput | null> {
  const res = await deps.fetch(openFdaSearchUrl(substance));
  if (!res.ok) return null;
  const label = chooseOpenFdaLabel(await res.json(), substance);
  return label === null ? null : openFdaSourceOf(label, ref);
}

/**
 * The PubChem annotations kept, by original source: which headings, what kind of source, and the licence printed on
 * it. A source not listed here is dropped whatever it says.
 */
const PUBCHEM_KEPT: Record<string, { key: string; kind: "livertox" | "lactmed" | "pubchem"; label: string; licence: string; headings: readonly string[] }> = {
  "LiverTox": { key: "livertox", kind: "livertox", label: "LiverTox (US NLM)", licence: "public domain (US NLM)", headings: ["LiverTox Summary", "Hepatotoxicity"] },
  "Drugs and Lactation Database (LactMed)": { key: "lactmed", kind: "lactmed", label: "LactMed (US NLM)", licence: "public domain (US NLM)", headings: ["Effects During Pregnancy and Lactation"] },
  "Medical Subject Headings (MeSH)": { key: "mesh", kind: "pubchem", label: "MeSH pharmacological class (US NLM)", licence: "public domain (US NLM)", headings: ["MeSH Pharmacological Classification"] },
  "FDA Pharm Classes": { key: "fdaclass", kind: "pubchem", label: "FDA Pharm Classes (US FDA)", licence: "public domain (US FDA)", headings: ["FDA Pharmacological Classification"] },
};

type PcSection = { TOCHeading?: string; Section?: PcSection[]; Information?: { ReferenceNumber?: number; Name?: string; Value?: { StringWithMarkup?: { String?: string }[] } }[] };
type PcReference = { ReferenceNumber?: number; SourceName?: string; URL?: string; LicenseURL?: string };

/** A PubChem PUG-View record → the kept sources (one per original database). Pure. */
export function pubchemSourcesOf(record: unknown, refSuffix: string, retrievedOn: string): DraftSourceInput[] {
  const rec = (record as { Record?: { RecordNumber?: number; Section?: PcSection[]; Reference?: PcReference[] } } | null)?.Record;
  if (rec === undefined) return [];
  const refs = new Map((rec.Reference ?? []).map((r) => [r.ReferenceNumber, r] as const));
  const texts = new Map<string, { parts: string[]; url: string | null }>();
  const walk = (sections: readonly PcSection[]): void => {
    for (const s of sections) {
      for (const info of s.Information ?? []) {
        const ref = refs.get(info.ReferenceNumber);
        const kept = ref?.SourceName === undefined ? undefined : PUBCHEM_KEPT[ref.SourceName];
        if (kept === undefined || !kept.headings.includes(s.TOCHeading ?? "")) continue;
        const text = (info.Value?.StringWithMarkup ?? []).map((m) => m.String ?? "").filter((t) => t.trim() !== "").join(" ").trim();
        if (text === "") continue;
        const slot = texts.get(ref!.SourceName!) ?? { parts: [], url: ref!.URL ?? null };
        if (!slot.parts.includes(text)) slot.parts.push(text);
        texts.set(ref!.SourceName!, slot);
      }
      walk(s.Section ?? []);
    }
  };
  walk(rec.Section ?? []);
  const cid = rec.RecordNumber;
  return Object.entries(PUBCHEM_KEPT).flatMap(([name, kept]) => {
    const slot = texts.get(name);
    if (slot === undefined) return [];
    const text = slot.parts.join("\n\n");
    return [{
      ref: `${kept.key}${refSuffix}`, kind: kept.kind,
      /* No compound id in the title: the title is sent unmasked, and a long id reads as a phone or Aadhaar number to
         the drafter's identifier check, which then refuses the whole draft. The id stays in the url. */
      title: `${kept.label} via PubChem · licence: ${kept.licence}`,
      url: slot.url ?? (cid === undefined ? null : `https://pubchem.ncbi.nlm.nih.gov/compound/${String(cid)}`),
      asOf: retrievedOn,
      text: text.length > PUBCHEM_SOURCE_MAX ? `${text.slice(0, PUBCHEM_SOURCE_MAX)} …` : text,
    }];
  });
}

/** PubChem's kept sources for one substance (name → CID → annotations). Empty when PubChem does not know it. */
export async function fetchPubchemSources(substance: string, refSuffix: string, deps: SourceDeps): Promise<DraftSourceInput[]> {
  const base = "https://pubchem.ncbi.nlm.nih.gov/rest";
  const idRes = await deps.fetch(`${base}/pug/compound/name/${encodeURIComponent(usNameOf(substance))}/cids/JSON`);
  if (!idRes.ok) return [];
  const cid = ((await idRes.json()) as { IdentifierList?: { CID?: unknown[] } } | null)?.IdentifierList?.CID?.[0];
  if (typeof cid !== "number") return [];
  const recRes = await deps.fetch(`${base}/pug_view/data/compound/${String(cid)}/JSON`);
  if (!recRes.ok) return [];
  return pubchemSourcesOf(await recRes.json(), refSuffix, deps.retrievedOn);
}

/** The names to look a generic up by: its linked substances, else its name before the strength, split at "+"/"and". */
export function lookupNamesFor(genericName: string, substanceNames: readonly string[]): string[] {
  const linked = [...new Set(substanceNames.map((s) => s.trim()).filter((s) => s !== ""))];
  if (linked.length > 0) return linked;
  const head = genericName.split(/\s\d|\(/)[0] ?? genericName;
  return [...new Set(head.split(/\s*\+\s*|\s+and\s+|\s*,\s*/i).map((s) => s.trim()).filter((s) => s !== ""))];
}

/**
 * Every usable source for a generic's substances: per substance its openFDA label, LiverTox and LactMed first, then
 * the class sources, up to {@link CRK_MAX_SOURCES}. A failed fetch is a missing source, never a stopped batch.
 */
export async function fetchCrkSources(substances: readonly string[], deps: SourceDeps): Promise<DraftSourceInput[]> {
  const first: DraftSourceInput[] = [];
  const later: DraftSourceInput[] = [];
  for (const [i, substance] of substances.entries()) {
    const suffix = String(i + 1);
    const fda = await fetchOpenFdaSource(substance, `fda${suffix}`, deps).catch(() => null);
    if (fda !== null) first.push(fda);
    const pc = await fetchPubchemSources(substance, suffix, deps).catch(() => []);
    for (const s of pc) (s.kind === "pubchem" ? later : first).push(s);
  }
  return [...first, ...later].slice(0, CRK_MAX_SOURCES);
}
