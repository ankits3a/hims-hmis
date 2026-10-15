import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { IPD_PACKAGE_SHARES_BP, IpdPackageImportInputSchema, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { ipdSchemePackages } from "../../kernel/db/schema";
import { requireIpdPermission } from "./admission-core";
import { IpdError } from "./errors";
import { IPD_PAYER_MANAGE, IPD_PAYER_TERMS } from "./permissions";
import type { Actor, IpdPackageImportResult, IpdSchemePackage } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #604 (decision 0075) — THE SCHEME PACKAGE MASTER (SPEC-tpa-desk-2026-10-15 rule 3). PM-JAY's Health Benefit Package
 * list (NHA HBP) or a state scheme's, loaded from a CSV the owner downloads from the scheme. The sample fixture
 * (`scripts/data/nha-hbp-sample.csv`) is eight synthetic rows; it is NOT the NHA list and is never presented as one.
 *
 * DECIDED: an import adds and updates, never retires a package the file omits (a partial list must not wipe the master);
 * a changed rate, name, specialty, kind or pre-auth flag retires the live row and inserts the new one, so a stay's
 * selected package keeps the rate it was chosen at. A file with any bad row writes nothing and names every bad line.
 */

export type PackageCsvRow = {
  line: number; code: string; name: string; specialty: string; kind: "surgical" | "medical" | "day_care"; ratePaise: number; preauthRequired: boolean;
};

/**
 * Column names accepted, after lower-casing and turning every run of non-alphanumerics into `_`, in PRIORITY order: an
 * NHA HBP sheet carries both "Package Code" (shared by its procedures) and "Procedure Code" (unique) — the procedure wins.
 */
const ALIASES: Record<keyof Omit<PackageCsvRow, "line">, readonly string[]> = {
  code: ["procedure_code", "hbp_code", "code", "package_code"],
  name: ["procedure_name", "name", "package_name"],
  specialty: ["specialty", "speciality", "specialty_name", "speciality_name"],
  ratePaise: ["rate_inr", "procedure_price", "package_rate", "base_rate", "rate", "price"],
  kind: ["kind", "procedure_type", "type"],
  preauthRequired: ["preauth", "pre_auth", "preauth_required", "pre_auth_required"],
};
const REQUIRED = ["code", "name", "specialty", "ratePaise", "kind"] as const;

/** RFC 4180 fields: quotes, doubled quotes, commas and newlines inside quotes. */
export function parseCsvRecords(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      out.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((f) => f.trim() !== ""));
}

const header = (h: string): string => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Rupees as typed ("12000", "1,20,000.50", "₹ 9,500") → integer paise; null when not a positive amount. */
export function rupeesToPaise(raw: string): number | null {
  const s = raw.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

function kindOf(raw: string): PackageCsvRow["kind"] | null {
  const k = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (k === "surgical" || k === "s") return "surgical";
  if (k === "medical" || k === "m") return "medical";
  if (k === "daycare" || k === "dc") return "day_care";
  return null;
}

function yesNo(raw: string | undefined): boolean | null {
  if (raw === undefined || raw.trim() === "") return true; // DECIDED: a scheme package needs pre-auth unless the file says no.
  const v = raw.trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(v)) return true;
  if (["n", "no", "false", "0"].includes(v)) return false;
  return null;
}

/** Pure: a CSV → rows, or every problem with its line number (header is line 1). */
export function parseSchemePackagesCsv(csv: string): { rows: PackageCsvRow[]; problems: string[] } {
  const records = parseCsvRecords(csv.replace(/^﻿/, ""));
  const problems: string[] = [];
  if (records.length === 0) return { rows: [], problems: ["line 1: the file is empty"] };
  const heads = records[0]!.map(header);
  const cols = new Map<string, number>();
  for (const [k, names] of Object.entries(ALIASES)) {
    const i = names.map((n) => heads.indexOf(n)).find((x) => x >= 0);
    if (i !== undefined) cols.set(k, i);
  }
  const missing = REQUIRED.filter((k) => !cols.has(k));
  if (missing.length > 0) return { rows: [], problems: [`line 1: missing column(s) ${missing.join(", ")}`] };
  const rows: PackageCsvRow[] = [];
  const seen = new Map<string, number>();
  records.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k: keyof Omit<PackageCsvRow, "line">): string => (cols.has(k) ? r[cols.get(k)!] ?? "" : "").trim();
    const code = get("code").toUpperCase();
    const bad: string[] = [];
    if (!/^[A-Z0-9][A-Z0-9.\-/]{0,31}$/.test(code)) bad.push("code");
    const name = get("name");
    if (name === "" || name.length > 300) bad.push("name");
    const specialty = get("specialty");
    if (specialty === "" || specialty.length > 120) bad.push("specialty");
    const ratePaise = rupeesToPaise(get("ratePaise"));
    if (ratePaise === null) bad.push("rate");
    const kind = kindOf(get("kind"));
    if (kind === null) bad.push("kind");
    const preauth = yesNo(cols.has("preauthRequired") ? get("preauthRequired") : undefined);
    if (preauth === null) bad.push("preauth");
    if (seen.has(code)) bad.push(`code repeats line ${String(seen.get(code))}`);
    if (bad.length > 0) { problems.push(`line ${String(line)}: bad ${bad.join(", ")}`); return; }
    seen.set(code, line);
    rows.push({ line, code, name, specialty, kind: kind!, ratePaise: ratePaise!, preauthRequired: preauth! });
  });
  if (rows.length === 0 && problems.length === 0) problems.push("line 2: no package rows");
  return { rows, problems };
}

/**
 * Loads (or, without `apply`, only measures) a scheme's package file. `ipd.payer.terms` (the billing manager): the
 * package rate is the payer amount of every scheme stay that chooses it.
 */
export async function importSchemePackages(db: Db, actor: Actor, raw: unknown, at: Date = new Date()): Promise<IpdPackageImportResult> {
  const input = IpdPackageImportInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_PAYER_TERMS);
  const { rows, problems } = parseSchemePackagesCsv(input.csv);
  if (problems.length > 0) throw new IpdError("package_import_invalid", "The package file has bad rows; nothing was written", { problems });
  const batch = newId();
  return withTx(db, async (tx) => {
    const live = new Map((await tx.select().from(ipdSchemePackages)
      .where(and(eq(ipdSchemePackages.scheme, input.scheme), isNull(ipdSchemePackages.retiredAt)))).map((p) => [p.code, p] as const));
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    for (const r of rows) {
      const cur = live.get(r.code);
      const same = cur !== undefined && cur.name === r.name && cur.specialty === r.specialty && cur.kind === r.kind
        && cur.ratePaise === r.ratePaise && cur.preauthRequired === r.preauthRequired;
      if (same) { unchanged += 1; continue; }
      if (cur === undefined) added += 1; else changed += 1;
      if (!input.apply) continue;
      if (cur !== undefined) {
        await tx.update(ipdSchemePackages).set({ retiredAt: at, retiredBy: actor.id }).where(eq(ipdSchemePackages.id, cur.id));
      }
      await tx.insert(ipdSchemePackages).values({
        id: newId(), scheme: input.scheme, code: r.code, name: r.name, specialty: r.specialty, kind: r.kind, ratePaise: r.ratePaise,
        preauthRequired: r.preauthRequired, importBatch: batch, importedBy: actor.id, importedAt: at,
      });
    }
    return { applied: input.apply, batch, rows: rows.length, added, changed, unchanged };
  });
}

/** The live packages of a scheme matching `q` (code or name), for the panel's picker. `ipd.payer.manage`. */
export async function searchSchemePackages(
  db: Db, actor: Actor, args: { scheme: "pmjay" | "state_scheme"; q?: string; limit?: number },
): Promise<IpdSchemePackage[]> {
  await requireIpdPermission(db, actor, IPD_PAYER_MANAGE);
  const q = args.q?.trim() ?? "";
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = await db.select().from(ipdSchemePackages)
    .where(and(
      eq(ipdSchemePackages.scheme, args.scheme), isNull(ipdSchemePackages.retiredAt),
      q === "" ? undefined : or(ilike(ipdSchemePackages.code, like), ilike(ipdSchemePackages.name, like)),
    ))
    .orderBy(asc(ipdSchemePackages.code)).limit(Math.min(args.limit ?? 20, 50));
  return rows.map((p) => ({
    id: p.id, scheme: p.scheme as IpdSchemePackage["scheme"], code: p.code, name: p.name, specialty: p.specialty,
    kind: p.kind as IpdSchemePackage["kind"], ratePaise: p.ratePaise, preauthRequired: p.preauthRequired,
  }));
}

/**
 * DECIDED $ (PM-JAY HBP multiple-package rule): the highest-rate package at 100 %, the second at 50 %, the third onward at
 * 25 %; ties by code. Each share is floored to the paisa. Pure.
 */
export function packageShares<T extends { code: string; ratePaise: number }>(list: readonly T[]): (T & { shareBp: number; amountPaise: number })[] {
  const sorted = [...list].sort((a, b) => b.ratePaise - a.ratePaise || a.code.localeCompare(b.code));
  return sorted.map((p, i) => {
    const shareBp = IPD_PACKAGE_SHARES_BP[Math.min(i, IPD_PACKAGE_SHARES_BP.length - 1)]!;
    return { ...p, shareBp, amountPaise: Math.floor((p.ratePaise * shareBp) / 10_000) };
  });
}
