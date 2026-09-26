import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══ ABDM S2 — A STRUCTURAL CHECKER FOR THE NRCeS FHIR IG v6.5.0, AND THE SLIM PROFILES IT READS ═══
 *
 * The IG package (`ndhm.in@6.5.0`, licence CC0-1.0) is on this box at
 * `/opt/hmis-context/reference/abdm/nrces-fhir-ig/` and NOT in CI. So the profiles the bundle
 * builders are checked against are committed as a SLIM extract — `test/fixtures/nrces-ig-6.5.0-slim.json`:
 * each StructureDefinition's snapshot reduced to what a structural check needs (id, path, min, max,
 * slice name, slicing, fixed values, types and target profiles). `slimProfiles` below is the ONE
 * function that makes it, and `fhir-records.test.ts` re-derives the extract from the package
 * whenever the package is present and fails if the committed copy differs — so the fixture cannot
 * silently drift from the IG it claims to be.
 *
 * WHAT `checkBundle` ENFORCES (and what it does not — the HL7 validator with `-ig` is still owed
 * before go-live, FT FAQ Q37):
 *   · DocumentBundle: every element the profile makes required, `type = document`, `urn:uuid:`
 *     fullUrls, the Composition first.
 *   · Every entry against the profile its `meta.profile[0]` names: every element with `min ≥ 1`
 *     present wherever its parent is present, every `max` respected, every fixed value equal, every
 *     `[x]` choice satisfied by one of its typed names.
 *   · Slices: Composition sections are matched to their slice by the fixed `code.coding.code`
 *     (OPConsultRecord's `openAtEnd` rule), and a matched section's entries must point at resources
 *     of the slice's target types; a CLOSED slicing (Condition/Observation `code.coding`, a
 *     record's `section.entry` by `type`) refuses any member that matches no slice.
 *   · References: every `reference` resolves to a `fullUrl` in the same bundle.
 * NOT enforced: terminology bindings, FHIRPath invariants, extensions.
 */
export const IG_PACKAGE_DIR = "/opt/hmis-context/reference/abdm/nrces-fhir-ig/pkg/package";
export const SLIM_FIXTURE = join(__dirname, "..", "fixtures", "nrces-ig-6.5.0-slim.json");
export const SLIM_PROFILES = [
  "DocumentBundle", "OPConsultRecord", "PrescriptionRecord", "DiagnosticReportRecord",
  "Patient", "Practitioner", "Organization", "Encounter", "Condition", "MedicationRequest", "ServiceRequest",
  "DiagnosticReportLab", "Observation", "DocumentReference", "Specimen",
] as const;

export type SlimElement = {
  id: string;
  path: string;
  min: number;
  max: string;
  sliceName?: string;
  slicing?: { discriminator: { type: string; path: string }[]; rules: string };
  fixed?: { key: string; value: unknown };
  types?: { code: string; targetProfile?: string[] }[];
};
export type SlimProfile = { url: string; type: string; elements: SlimElement[] };
export type SlimIg = { source: string; profiles: Record<string, SlimProfile> };

type RawElement = {
  id: string; path: string; min?: number; max?: string; sliceName?: string;
  slicing?: { discriminator?: { type: string; path: string }[]; rules?: string };
  type?: { code: string; targetProfile?: string[] }[];
  [k: string]: unknown;
};

/** The one slimmer — used to write the fixture and, when the package is present, to re-check it. */
export function slimProfiles(packageDir: string): SlimIg {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name: string; version: string; license: string };
  const profiles: Record<string, SlimProfile> = {};
  for (const name of SLIM_PROFILES) {
    const sd = JSON.parse(readFileSync(join(packageDir, `StructureDefinition-${name}.json`), "utf8")) as {
      url: string; type: string; snapshot: { element: RawElement[] };
    };
    const elements: SlimElement[] = [];
    for (const e of sd.snapshot.element) {
      if (/(^|\.)(extension|modifierExtension)(:|\.|$)/.test(e.id)) continue;
      const out: SlimElement = { id: e.id, path: e.path, min: e.min ?? 0, max: e.max ?? "*" };
      if (e.sliceName !== undefined) out.sliceName = e.sliceName;
      if (e.slicing !== undefined) out.slicing = { discriminator: e.slicing.discriminator ?? [], rules: e.slicing.rules ?? "open" };
      const fixedKey = Object.keys(e).find((k) => k.startsWith("fixed") || k.startsWith("pattern"));
      if (fixedKey !== undefined) out.fixed = { key: fixedKey, value: e[fixedKey] };
      if (e.type !== undefined) out.types = e.type.map((t) => (t.targetProfile === undefined ? { code: t.code } : { code: t.code, targetProfile: t.targetProfile }));
      // Only what a structural check reads: a requirement, a prohibition, a slice, a fixed value,
      // or a section entry's target types. Everything else is FHIR's base and says nothing new.
      const targets = e.path.endsWith(".entry") && (e.type ?? []).some((t) => t.targetProfile !== undefined);
      if (out.min > 0 || out.max === "0" || out.sliceName !== undefined || out.slicing !== undefined || out.fixed !== undefined || targets) {
        if (!targets) delete out.types;
        elements.push(out);
      }
    }
    profiles[name] = { url: sd.url, type: sd.type, elements };
  }
  return { source: `${pkg.name}@${pkg.version} (${pkg.license}) — StructureDefinition snapshots, slimmed by test/helpers/fhir-ig.ts`, profiles };
}

export function loadSlimIg(): SlimIg {
  return JSON.parse(readFileSync(SLIM_FIXTURE, "utf8")) as SlimIg;
}

export function igPackagePresent(): boolean {
  return existsSync(join(IG_PACKAGE_DIR, "package.json"));
}

// ─────────────────────────────────────────── the checker ───────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const tail = (profileUrl: string): string => profileUrl.split("/").pop() ?? profileUrl;

/** Resolve the children named by `name` on each node (`value[x]` → any `valueFoo`). */
function childValues(node: Json, name: string): unknown[] {
  if (name.endsWith("[x]")) {
    const stem = name.slice(0, -3);
    const key = Object.keys(node).find((k) => k.startsWith(stem) && k.length > stem.length && /[A-Z]/.test(k[stem.length]!));
    return key === undefined ? [] : asArray(node[key]);
  }
  return asArray(node[name]);
}

function pathTypeOf(key: string): string | null {
  const m = /^(fixed|pattern)(.+)$/.exec(key);
  return m === null ? null : m[2]!;
}

export class IgChecker {
  private readonly byUrl = new Map<string, SlimProfile>();

  constructor(private readonly ig: SlimIg) {
    for (const p of Object.values(ig.profiles)) this.byUrl.set(p.url, p);
  }

  profile(name: string): SlimProfile {
    const p = this.ig.profiles[name];
    if (p === undefined) throw new Error(`no slim profile ${name}`);
    return p;
  }

  /** All problems with one document bundle; an empty list means it passed. */
  checkBundle(bundle: unknown): string[] {
    const errors: string[] = [];
    if (!isObj(bundle)) return ["bundle is not an object"];
    this.checkResource(bundle, this.profile("DocumentBundle"), "Bundle", errors);
    const entries = asArray(bundle.entry).filter(isObj);
    if (entries.length === 0) errors.push("Bundle.entry is empty");
    const fullUrls = new Map<string, Json>();
    for (const [i, e] of entries.entries()) {
      const url = e.fullUrl;
      if (typeof url !== "string" || !/^urn:uuid:[0-9a-f-]{36}$/.test(url)) errors.push(`Bundle.entry[${i}].fullUrl must be urn:uuid (got ${String(url)})`);
      if (!isObj(e.resource)) { errors.push(`Bundle.entry[${i}].resource missing`); continue; }
      if (typeof url === "string") fullUrls.set(url, e.resource);
    }
    const first = entries[0]?.resource;
    if (!isObj(first) || first.resourceType !== "Composition") errors.push("the first entry must be the Composition");
    for (const [i, e] of entries.entries()) {
      const r = e.resource;
      if (!isObj(r)) continue;
      const profileUrl = asArray(isObj(r.meta) ? r.meta.profile : undefined)[0];
      const profile = typeof profileUrl === "string" ? this.byUrl.get(profileUrl) : undefined;
      if (profile === undefined) { errors.push(`entry[${i}] ${String(r.resourceType)}: meta.profile ${String(profileUrl)} is not a checked NRCeS profile`); continue; }
      if (profile.type !== r.resourceType) errors.push(`entry[${i}]: ${String(r.resourceType)} claims profile ${tail(profile.url)} of type ${profile.type}`);
      this.checkResource(r, profile, profile.type, errors, fullUrls);
    }
    // every reference resolves inside the bundle
    const walk = (v: unknown, where: string): void => {
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
      if (!isObj(v)) return;
      for (const [k, x] of Object.entries(v)) {
        if (k === "reference" && typeof x === "string" && !fullUrls.has(x)) errors.push(`${where}.reference ${x} does not resolve in the bundle`);
        walk(x, `${where}.${k}`);
      }
    };
    entries.forEach((e, i) => walk(e.resource, `entry[${i}]`));
    return errors;
  }

  private checkResource(resource: Json, profile: SlimProfile, root: string, errors: string[], fullUrls?: Map<string, Json>): void {
    const tag = `${tail(profile.url)}`;
    // Unsliced elements: cardinality + fixed values, evaluated at every instance of the parent.
    for (const el of profile.elements) {
      if (el.id.includes(":")) continue; // slice members are checked by `checkSlices`
      if (el.path === root) continue;
      const parentPath = el.path.slice(0, el.path.lastIndexOf("."));
      const name = el.path.slice(el.path.lastIndexOf(".") + 1);
      for (const parent of this.instances(resource, root, parentPath)) {
        const values = childValues(parent, name);
        if (values.length < el.min) errors.push(`${tag}: ${el.path} is required (min ${el.min})`);
        if (el.max === "0" && values.length > 0) errors.push(`${tag}: ${el.path} is prohibited`);
        else if (el.max !== "*" && values.length > Number(el.max)) errors.push(`${tag}: ${el.path} allows at most ${el.max}, got ${values.length}`);
        if (el.fixed !== undefined && pathTypeOf(el.fixed.key) !== null) {
          for (const v of values) {
            if (JSON.stringify(v) !== JSON.stringify(el.fixed.value) && !(isObj(v) && isObj(el.fixed.value) && Object.entries(el.fixed.value).every(([k, x]) => JSON.stringify(v[k]) === JSON.stringify(x)))) {
              errors.push(`${tag}: ${el.path} must be ${JSON.stringify(el.fixed.value)}, got ${JSON.stringify(v)}`);
            }
          }
        }
      }
    }
    this.checkSlices(resource, profile, root, errors, fullUrls);
  }

  /** Every instance of the element at `path` (e.g. `Composition.section.entry`) within `resource`. */
  private instances(resource: Json, root: string, path: string): Json[] {
    if (path === root) return [resource];
    const parts = path.slice(root.length + 1).split(".");
    let nodes: unknown[] = [resource];
    for (const p of parts) nodes = nodes.flatMap((n) => (isObj(n) ? childValues(n, p) : []));
    return nodes.filter(isObj);
  }

  private checkSlices(resource: Json, profile: SlimProfile, root: string, errors: string[], fullUrls?: Map<string, Json>): void {
    const tag = tail(profile.url);
    for (const slicer of profile.elements.filter((e) => e.slicing !== undefined && !e.id.includes(":"))) {
      const slices = profile.elements.filter((e) => e.path === slicer.path && e.sliceName !== undefined && e.id === `${slicer.id}:${e.sliceName}`);
      if (slices.length === 0) continue;
      const disc = slicer.slicing!.discriminator[0];
      if (disc === undefined || disc.type !== "value") continue;
      const parentPath = slicer.path.slice(0, slicer.path.lastIndexOf("."));
      const name = slicer.path.slice(slicer.path.lastIndexOf(".") + 1);
      // The discriminator's fixed value for each slice, e.g. section:ChiefComplaints → code.coding.code = 422843007.
      const want = new Map<string, unknown>();
      for (const s of slices) {
        const fixedEl = profile.elements.find((e) => e.id === `${s.id}.${disc.path}` && e.fixed !== undefined);
        if (fixedEl !== undefined) want.set(s.sliceName!, fixedEl.fixed!.value);
      }
      for (const parent of this.instances(resource, root, parentPath)) {
        const members = childValues(parent, name).filter(isObj);
        const counts = new Map<string, number>();
        for (const m of members) {
          const value = this.valueAt(m, disc.path);
          const slice = slices.find((s) => want.has(s.sliceName!) && value.some((v) => JSON.stringify(v) === JSON.stringify(want.get(s.sliceName!))));
          if (slice === undefined) {
            if (slicer.slicing!.rules === "closed") errors.push(`${tag}: ${slicer.path} member ${JSON.stringify(value)} matches no slice (closed)`);
            continue;
          }
          counts.set(slice.sliceName!, (counts.get(slice.sliceName!) ?? 0) + 1);
          this.checkSliceMember(m, slice, profile, errors, fullUrls);
        }
        for (const s of slices) {
          const n = counts.get(s.sliceName!) ?? 0;
          if (n < s.min) errors.push(`${tag}: ${slicer.path}:${s.sliceName} is required (min ${s.min})`);
          if (s.max !== "*" && n > Number(s.max)) errors.push(`${tag}: ${slicer.path}:${s.sliceName} allows at most ${s.max}, got ${n}`);
        }
      }
    }
  }

  private valueAt(node: Json, dotted: string): unknown[] {
    let nodes: unknown[] = [node];
    for (const p of dotted.split(".")) nodes = nodes.flatMap((n) => (isObj(n) ? childValues(n, p) : []));
    return nodes;
  }

  /** A matched slice member: its own required children and fixed values, and its targets' types. */
  private checkSliceMember(member: Json, slice: SlimElement, profile: SlimProfile, errors: string[], fullUrls?: Map<string, Json>): void {
    const tag = tail(profile.url);
    const children = profile.elements.filter((e) => e.id.startsWith(`${slice.id}.`) && !e.id.slice(slice.id.length + 1).includes(":"));
    for (const el of children) {
      const rel = el.id.slice(slice.id.length + 1);
      const parts = rel.split(".");
      const parents = parts.length === 1 ? [member] : this.valueAt(member, parts.slice(0, -1).join(".")).filter(isObj);
      for (const parent of parents) {
        const values = childValues(parent, parts[parts.length - 1]!);
        if (values.length < el.min) errors.push(`${tag}: ${slice.id}.${rel} is required (min ${el.min})`);
        if (el.max !== "*" && values.length > Number(el.max)) errors.push(`${tag}: ${slice.id}.${rel} allows at most ${el.max}`);
        if (el.fixed !== undefined) {
          for (const v of values) if (JSON.stringify(v) !== JSON.stringify(el.fixed.value)) errors.push(`${tag}: ${slice.id}.${rel} must be ${JSON.stringify(el.fixed.value)}, got ${JSON.stringify(v)}`);
        }
      }
      // A section slice's `entry` names the resource types it may point at.
      if (rel === "entry" && el.types !== undefined && fullUrls !== undefined) {
        const allowed = new Set(el.types.flatMap((t) => (t.targetProfile ?? []).map((p) => this.byUrl.get(p)?.type ?? tail(p))));
        for (const ref of asArray(member.entry).filter(isObj)) {
          const target = typeof ref.reference === "string" ? fullUrls.get(ref.reference) : undefined;
          if (target !== undefined && allowed.size > 0 && !allowed.has(String(target.resourceType)) && !allowed.has("Resource")) {
            errors.push(`${tag}: ${slice.id}.entry points at ${String(target.resourceType)}, allowed ${[...allowed].join("|")}`);
          }
        }
      }
    }
  }
}
