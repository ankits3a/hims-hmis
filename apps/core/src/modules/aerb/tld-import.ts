import { eq, inArray } from "drizzle-orm";
import { aerbTldBadges, aerbTldReads, aerbPregnancyDeclarations } from "../../kernel/db/schema/aerb";
import { users } from "../../kernel/db/schema/auth";
import { AerbError } from "./errors";
import { requireManage } from "./access";
import { investigationLevelPerMonth, recordBadgeRead } from "./badges";
import {
  ANNUAL_LIMIT_MSV, FIVE_YEAR_AVERAGE_LIMIT_MSV, PREGNANT_WORKER_FOETAL_LIMIT_MSV, investigationLevelFor,
} from "./limits";
import { foetalShare } from "./pregnancy";
import type { Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T1 — **THE QUARTERLY TLD REPORT, IMPORTED WHOLE OR NOT AT ALL.**
 *
 * The BARC-accredited personnel-monitoring service (ruling 5) sends one report a quarter. Until now
 * the RSO typed each line into `POST /aerb/badges/reads`. This reads the service's CSV, checks every
 * line against the badge book, shows the RSO a preview (the dry run) and, on confirm, writes every
 * line through `recordBadgeRead` in ONE transaction — so each line gets exactly the checks, the
 * stored investigation verdict and the `radiation.dose_limit_warning` event a typed line gets.
 *
 * ═══ ALL-OR-NOTHING ═══
 *
 * One bad line refuses the whole file (`tld_import_rejected`, every row and its errors in the
 * detail). A partial import is the failure this exists to prevent: the RSO would believe the quarter
 * is on file while three workers' doses are not, and nothing would say which three.
 *
 * ═══ THE LAYOUT (DECIDED — the common Indian service report) ═══
 *
 * One header row, then one row per badge per wearing period. Columns, matched tolerantly (case,
 * spaces, punctuation and units in brackets ignored; synonyms below):
 *   badge no. · wearer name · period from · period to · Hp(10) mSv · Hp(0.07) mSv · remarks
 * Badge no., period from/to and Hp(10) are required; the rest are optional. Dates are Indian
 * day-first (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, 01-Jul-2026) or ISO. A dose written as BDL / ND /
 * NIL / "-" / "<0.05" (below the detection limit) is recorded as 0.000 mSv with the service's own
 * words kept in the remarks.
 */

const MAX_ROWS = 2000;

/** The header synonyms, normalised (lowercase, letters and digits only). */
const HEADERS: Record<ImportColumn, readonly string[]> = {
  badgeNo: ["badgeno", "badgenumber", "badge", "badgeid", "tldno", "tldnumber", "tldbadgeno", "tldbadgenumber", "dosimeterno", "dosimeternumber", "tldid"],
  wearer: ["wearername", "wearer", "name", "workername", "nameofwearer", "nameoftheworker", "nameofradiationworker", "radiationworker", "personname", "employeename"],
  periodFrom: ["periodfrom", "from", "fromdate", "wearfrom", "wearingfrom", "periodstart", "startdate", "monitoringperiodfrom", "issuedate", "dateofissue"],
  periodTo: ["periodto", "to", "todate", "wearto", "wearingto", "periodend", "enddate", "monitoringperiodto", "returndate", "dateofreturn"],
  hp10: ["hp10", "hp10msv", "dosehp10", "hp10dose", "wholebody", "wholebodydose", "wholebodydosemsv", "deepdose", "personaldosehp10"],
  hp007: ["hp007", "hp007msv", "dosehp007", "hp007dose", "skindose", "skin", "shallowdose", "personaldosehp007"],
  remarks: ["remarks", "remark", "comments", "comment", "note", "notes"],
};
type ImportColumn = "badgeNo" | "wearer" | "periodFrom" | "periodTo" | "hp10" | "hp007" | "remarks";
const REQUIRED: readonly ImportColumn[] = ["badgeNo", "periodFrom", "periodTo", "hp10"];

function normHeader(h: string): string {
  // "Hp(10) (mSv)" → "hp10msv"; "Hp(0.07)" → "hp007"
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** RFC-4180-ish: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function splitCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      if (c === "\"") {
        if (src[i + 1] === "\"") { field += "\""; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === "\"") { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
      continue;
    }
    field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function realDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Day-first Indian dates or ISO. Null when it is not a real date. */
export function parseReportDate(raw: string): string | null {
  const v = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) return realDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s/.-]([A-Za-z]{3,9})[\s/.-](\d{4})$/.exec(v);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    return month === undefined ? null : realDate(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

/** A dose cell: a number, or the service's below-detection wording (→ 0 with a note). */
export function parseDose(raw: string): { value: number; note: string | null } | null {
  const v = raw.trim();
  if (/^(bdl|nd|nil|n\.d\.|-|—|m)$/i.test(v) || /^<\s*\d+(\.\d+)?$/.test(v)) {
    return { value: 0, note: `reported "${v}" (below the detection limit), recorded as 0.000 mSv` };
  }
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? { value: n, note: null } : null;
}

function normName(n: string): string {
  return n.toLowerCase().replace(/\b(mr|mrs|ms|miss|dr|shri|smt|kumari)\b\.?/g, " ").replace(/[^a-z]/g, "");
}

export interface TldImportRow {
  /** 1-based line in the file, the header being line 1. */
  line: number;
  badgeNo: string;
  wearer: string | null;
  /** The badge book's holder, when the badge was found. */
  userId: string | null;
  userName: string | null;
  badgeId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  hp10Msv: number | null;
  hp007Msv: number | null;
  remarks: string | null;
  /** Reasons the file is refused. Any row with one refuses the whole file. */
  errors: string[];
  /** Worth the RSO's eye; they do not refuse the file. */
  warnings: string[];
  /** Hp(10) at or over the investigation level pro-rated to this period (ruling 5). */
  overInvestigationLevel: boolean;
  investigationLevelMsv: number | null;
  /** The worker's calendar-year total with this read, and that total projected to a full year. */
  yearTotalMsv: number | null;
  projectedAnnualMsv: number | null;
  /** Projection over the 20 mSv five-year-average annual limit. */
  overAnnualProjection: boolean;
  /** The year's total over the 30 mSv single-year limit. */
  overAnnualLimit: boolean;
  /** A declared-pregnant worker whose post-declaration reads reach the 1 mSv foetal limit. */
  overFoetalLimit: boolean;
}

export interface TldImportReport {
  dryRun: boolean;
  columns: Partial<Record<ImportColumn, string>>;
  rows: TldImportRow[];
  errorCount: number;
  /** Rows written. Zero on a dry run and on any refused file. */
  imported: number;
  flagged: { investigation: number; annualProjection: number; annualLimit: number; foetal: number };
}

export interface TldImportInput {
  csv: string;
  /** The date on the service's report — every line carries it. */
  reportedOn: string;
  /** The service's report / dispatch number, kept on every line. */
  labRef?: string | null;
  dryRun: boolean;
}

function daysBetweenInclusive(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Days of [start,end] inside calendar year `year`. */
function daysInYear(start: string, end: string, year: string): number {
  const s = start > `${year}-01-01` ? start : `${year}-01-01`;
  const e = end < `${year}-12-31` ? end : `${year}-12-31`;
  return e < s ? 0 : daysBetweenInclusive(s, e);
}

/**
 * Parse, check and (unless a dry run) write. The caller owns the transaction; a refused file throws
 * `tld_import_rejected` and the caller's rollback takes everything with it.
 */
export async function importTldReads(tx: Tx, actor: Actor, input: TldImportInput): Promise<TldImportReport> {
  await requireManage(tx, actor, "a TLD report is entered by a person");
  const reportedOn = parseReportDate(input.reportedOn);
  if (reportedOn === null) {
    throw new AerbError("invalid_validity", `reportedOn "${input.reportedOn}" is not a date`);
  }

  const table = splitCsv(input.csv);
  const header = table[0];
  if (header === undefined) {
    throw new AerbError("tld_import_rejected", "the file is empty — expected a header row and one row per badge", { rows: [] });
  }
  const columns: Partial<Record<ImportColumn, string>> = {};
  const index: Partial<Record<ImportColumn, number>> = {};
  const claim = (col: ImportColumn, i: number): void => {
    if (index[col] === undefined && !Object.values(index).includes(i)) { index[col] = i; columns[col] = header[i]!.trim(); }
  };
  /** Exact synonyms first … */
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const col of Object.keys(HEADERS) as ImportColumn[]) if (HEADERS[col].includes(n)) claim(col, i);
  });
  /** … then the shapes a service's own wording takes ("Name of the Radiation Worker", "Wear period to"). */
  header.forEach((h, i) => {
    const n = normHeader(h);
    if (/(badge|tld|dosimeter)/.test(n) && /(no|number|id)$/.test(n)) claim("badgeNo", i);
    else if (/hp10/.test(n) || /(wholebody|deepdose)/.test(n)) claim("hp10", i);
    else if (/hp007/.test(n) || /(skin|shallow)/.test(n)) claim("hp007", i);
    else if (/name/.test(n)) claim("wearer", i);
    else if (/(from|start)/.test(n)) claim("periodFrom", i);
    else if (/(to|end|upto)$/.test(n) || /periodto/.test(n)) claim("periodTo", i);
    else if (/(remark|comment|note)/.test(n)) claim("remarks", i);
  });
  const missing = REQUIRED.filter((c) => index[c] === undefined);
  if (missing.length > 0) {
    throw new AerbError(
      "tld_import_rejected",
      `the header row has no ${missing.map((c) => ({ badgeNo: "badge number", periodFrom: "period from", periodTo: "period to", hp10: "Hp(10) mSv" } as Record<string, string>)[c]).join(", ")} column — `
      + `found: ${header.map((h) => `"${h.trim()}"`).join(", ")}`,
      { rows: [], missingColumns: missing, header },
    );
  }
  const body = table.slice(1);
  if (body.length === 0) {
    throw new AerbError("tld_import_rejected", "the file has a header and no readings", { rows: [] });
  }
  if (body.length > MAX_ROWS) {
    throw new AerbError("tld_import_rejected", `the file has ${String(body.length)} rows; one import takes at most ${String(MAX_ROWS)}`, { rows: [] });
  }

  const cell = (r: string[], c: ImportColumn): string => {
    const i = index[c];
    return i === undefined ? "" : (r[i] ?? "").trim();
  };

  /* ── the badge book, once ── */
  const badgeNos = [...new Set(body.map((r) => cell(r, "badgeNo")).filter((b) => b !== ""))];
  const badges = badgeNos.length === 0 ? [] : await tx.select({
    id: aerbTldBadges.id, badgeNo: aerbTldBadges.badgeNo, userId: aerbTldBadges.userId,
    issuedOn: aerbTldBadges.issuedOn, returnedOn: aerbTldBadges.returnedOn, status: aerbTldBadges.status,
    userName: users.fullName,
  })
    .from(aerbTldBadges)
    .innerJoin(users, eq(users.id, aerbTldBadges.userId))
    .where(inArray(aerbTldBadges.badgeNo, badgeNos));

  const perMonth = await investigationLevelPerMonth(tx);

  const rows: TldImportRow[] = body.map((r, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const badgeNo = cell(r, "badgeNo");
    const wearer = cell(r, "wearer") || null;
    const fromRaw = cell(r, "periodFrom");
    const toRaw = cell(r, "periodTo");
    const periodStart = parseReportDate(fromRaw);
    const periodEnd = parseReportDate(toRaw);
    const hp10 = parseDose(cell(r, "hp10"));
    const hp007Raw = cell(r, "hp007");
    const hp007 = hp007Raw === "" ? null : parseDose(hp007Raw);
    const notes: string[] = [];
    const remarkCell = cell(r, "remarks");
    if (remarkCell !== "") notes.push(remarkCell);

    if (badgeNo === "") errors.push("no badge number");
    if (periodStart === null) errors.push(`period from "${fromRaw}" is not a date (day-first DD/MM/YYYY or YYYY-MM-DD)`);
    if (periodEnd === null) errors.push(`period to "${toRaw}" is not a date (day-first DD/MM/YYYY or YYYY-MM-DD)`);
    if (periodStart !== null && periodEnd !== null && periodEnd < periodStart) {
      errors.push(`period to ${periodEnd} is before period from ${periodStart}`);
    }
    if (periodEnd !== null && periodEnd > reportedOn) {
      errors.push(`the period ends ${periodEnd}, after the report date ${reportedOn} — a badge is read after it is worn`);
    }
    if (hp10 === null) errors.push(`Hp(10) "${cell(r, "hp10")}" is not a dose in mSv`);
    else if (hp10.note !== null) notes.push(`Hp(10) ${hp10.note}`);
    if (hp007Raw !== "" && hp007 === null) errors.push(`Hp(0.07) "${hp007Raw}" is not a dose in mSv`);
    else if (hp007 !== null && hp007.note !== null) notes.push(`Hp(0.07) ${hp007.note}`);

    /**
     * The badge. A number is re-used after a badge is returned, so the badge is the one whose
     * wearing span covers this period; with no period to match, any holder of the number is shown.
     */
    const candidates = badges.filter((b) => b.badgeNo === badgeNo);
    const badge = periodStart !== null && periodEnd !== null
      ? candidates.find((b) => b.issuedOn <= periodEnd && (b.returnedOn === null || b.returnedOn >= periodStart))
      : undefined;
    if (badgeNo !== "" && candidates.length === 0) {
      errors.push(`badge ${badgeNo} is not in the badge book — issue it on the Badges tab first, or correct the number`);
    } else if (badgeNo !== "" && badge === undefined && periodStart !== null && periodEnd !== null) {
      const c = candidates[0]!;
      errors.push(
        `badge ${badgeNo} (${c.userName}) was not worn ${periodStart}..${periodEnd} — issued ${c.issuedOn}`
        + (c.returnedOn === null ? "" : `, returned ${c.returnedOn}`),
      );
    }
    if (badge !== undefined && wearer !== null) {
      const a = normName(wearer);
      const b = normName(badge.userName);
      if (a !== "" && !(a === b || b.includes(a) || a.includes(b))) {
        warnings.push(`the service names the wearer "${wearer}"; the badge book says ${badge.userName}`);
      }
    }

    return {
      line: i + 2,
      badgeNo,
      wearer,
      userId: badge?.userId ?? null,
      userName: badge?.userName ?? candidates[0]?.userName ?? null,
      badgeId: badge?.id ?? null,
      periodStart,
      periodEnd,
      hp10Msv: hp10?.value ?? null,
      hp007Msv: hp007?.value ?? null,
      remarks: notes.length === 0 ? null : notes.join("; "),
      errors,
      warnings,
      overInvestigationLevel: false,
      investigationLevelMsv: null,
      yearTotalMsv: null,
      projectedAnnualMsv: null,
      overAnnualProjection: false,
      overAnnualLimit: false,
      overFoetalLimit: false,
    };
  });

  /* ── duplicate periods: inside the file, and against the register ── */
  const seen = new Map<string, TldImportRow>();
  for (const row of rows) {
    if (row.badgeId === null || row.periodStart === null || row.periodEnd === null) continue;
    const key = `${row.badgeId} ${row.periodStart} ${row.periodEnd}`;
    const first = seen.get(key);
    if (first !== undefined) {
      row.errors.push(`line ${String(first.line)} already carries badge ${row.badgeNo} for ${row.periodStart}..${row.periodEnd}`);
      first.errors.push(`line ${String(row.line)} repeats badge ${row.badgeNo} for ${row.periodStart}..${row.periodEnd}`);
    } else seen.set(key, row);
  }
  const badgeIds = [...new Set(rows.map((r) => r.badgeId).filter((b): b is string => b !== null))];
  const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => u !== null))];
  const onFile = badgeIds.length === 0 ? [] : await tx.select({
    badgeId: aerbTldReads.badgeId, periodStart: aerbTldReads.periodStart, periodEnd: aerbTldReads.periodEnd,
  }).from(aerbTldReads).where(inArray(aerbTldReads.badgeId, badgeIds));
  for (const row of rows) {
    const hit = onFile.find((o) => o.badgeId === row.badgeId && o.periodStart === row.periodStart && o.periodEnd === row.periodEnd);
    if (hit !== undefined) {
      row.errors.push(`badge ${row.badgeNo} already has a reading on file for ${row.periodStart ?? ""}..${row.periodEnd ?? ""} — a re-sent report is a correction, not a second dose`);
    }
  }

  /* ── the flags: investigation level, the year's projection, the foetal limit ── */
  const workerReads = userIds.length === 0 ? [] : await tx.select({
    userId: aerbTldBadges.userId, periodStart: aerbTldReads.periodStart, periodEnd: aerbTldReads.periodEnd,
    hp10: aerbTldReads.hp10Msv,
  })
    .from(aerbTldReads)
    .innerJoin(aerbTldBadges, eq(aerbTldBadges.id, aerbTldReads.badgeId))
    .where(inArray(aerbTldBadges.userId, userIds));
  const declarations = userIds.length === 0 ? [] : await tx.select().from(aerbPregnancyDeclarations)
    .where(inArray(aerbPregnancyDeclarations.userId, userIds));

  /** Running per-worker picture: what is on file plus the rows of this file above this one. */
  const running = new Map<string, { periodStart: string; periodEnd: string; hp10: number }[]>();
  for (const w of workerReads) {
    (running.get(w.userId) ?? running.set(w.userId, []).get(w.userId)!)
      .push({ periodStart: w.periodStart, periodEnd: w.periodEnd, hp10: Number(w.hp10) });
  }
  for (const row of rows) {
    if (row.userId === null || row.periodStart === null || row.periodEnd === null || row.hp10Msv === null) continue;
    const level = investigationLevelFor(perMonth, row.periodStart, row.periodEnd);
    row.investigationLevelMsv = Number(level.toFixed(3));
    row.overInvestigationLevel = row.hp10Msv >= level;

    const mine = running.get(row.userId) ?? running.set(row.userId, []).get(row.userId)!;
    mine.push({ periodStart: row.periodStart, periodEnd: row.periodEnd, hp10: row.hp10Msv });
    const year = row.periodEnd.slice(0, 4);
    const inYear = mine.filter((m) => m.periodEnd.slice(0, 4) === year);
    const total = inYear.reduce((a, m) => a + m.hp10, 0);
    const worn = inYear.reduce((a, m) => a + daysInYear(m.periodStart, m.periodEnd, year), 0);
    const yearDays = daysBetweenInclusive(`${year}-01-01`, `${year}-12-31`);
    const projected = worn > 0 ? (total / worn) * yearDays : total;
    row.yearTotalMsv = Number(total.toFixed(3));
    row.projectedAnnualMsv = Number(projected.toFixed(3));
    row.overAnnualProjection = projected > FIVE_YEAR_AVERAGE_LIMIT_MSV;
    row.overAnnualLimit = total > ANNUAL_LIMIT_MSV;

    const decl = declarations.find((d) => d.userId === row.userId && d.declaredOn <= row.periodEnd! && (d.endedOn === null || d.endedOn >= row.periodStart!));
    if (decl !== undefined) {
      const since = mine.reduce((a, m) => a + foetalShare(m, decl), 0);
      row.overFoetalLimit = since >= PREGNANT_WORKER_FOETAL_LIMIT_MSV;
      if (row.overFoetalLimit) {
        row.warnings.push(
          `declared pregnant worker: ${since.toFixed(3)} mSv since ${decl.declaredOn} reaches the `
          + `${String(PREGNANT_WORKER_FOETAL_LIMIT_MSV)} mSv foetal limit — restrict her ionising work and record an incident`,
        );
      }
    }
  }

  const errorCount = rows.filter((r) => r.errors.length > 0).length;
  const flagged = {
    investigation: rows.filter((r) => r.overInvestigationLevel).length,
    annualProjection: rows.filter((r) => r.overAnnualProjection).length,
    annualLimit: rows.filter((r) => r.overAnnualLimit).length,
    foetal: rows.filter((r) => r.overFoetalLimit).length,
  };
  const report: TldImportReport = { dryRun: input.dryRun, columns, rows, errorCount, imported: 0, flagged };
  if (input.dryRun) return report;

  if (errorCount > 0) {
    throw new AerbError(
      "tld_import_rejected",
      `${String(errorCount)} of ${String(rows.length)} lines cannot be entered, so nothing was — `
      + "correct the file (or the badge book) and import it again",
      { rows, errorCount },
    );
  }

  for (const row of rows) {
    await recordBadgeRead(tx, actor, {
      badgeId: row.badgeId!,
      periodStart: row.periodStart!,
      periodEnd: row.periodEnd!,
      hp10Msv: row.hp10Msv!,
      hp007Msv: row.hp007Msv,
      reportedOn,
      labRef: input.labRef ?? null,
      remarks: row.remarks,
    });
  }
  return { ...report, imported: rows.length };
}
