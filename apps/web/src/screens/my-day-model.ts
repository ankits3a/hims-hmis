import type { WireBrief, WireDesk, WireReportSection } from "../lib/desk-api";

/**
 * MY DAY REDESIGN (owner 2026-10-05, board approved as "go ahead and get this screen live").
 *
 * Everything on the new screen is a READING of what the server already sent — the report's
 * sections, the brief's clauses and the desk's cards. This module turns those payloads into the
 * shapes the screen draws, and computes nothing the server has not already decided: a count here
 * is a count of rows the report listed, a percentage is the arithmetic between two figures the
 * brief printed. The printed shift report and the CSV still come from the report alone (DD5).
 */

/** The visit statuses, grouped the way the filters read them. */
export type StatusTone = "reg" | "wait" | "doc" | "done" | "left";

export function statusTone(code: string): StatusTone {
  switch (code) {
    case "registered": return "reg";
    case "waiting": return "wait";
    case "in_consultation":
    case "awaiting_results": return "doc";
    case "completed": return "done";
    case "abandoned": return "left";
    default: return "reg";
  }
}

export function outcomeTone(code: string): StatusTone {
  switch (code) {
    case "referred": return "wait";
    case "prescribed": return "done";
    default: return "doc";
  }
}

export type VisitFilter = "all" | "waiting" | "doctor" | "done" | "left";

export function matchesFilter(filter: VisitFilter, tone: StatusTone): boolean {
  switch (filter) {
    case "all": return true;
    case "waiting": return tone === "reg" || tone === "wait";
    case "doctor": return tone === "doc";
    case "done": return tone === "done";
    case "left": return tone === "left";
  }
}

/** A report row read by column KEY, so a provider that reorders its columns does not move a cell. */
export type ReportRow = Record<string, string>;

export function rowsOf(section: WireReportSection | undefined): ReportRow[] {
  if (section === undefined) return [];
  return section.rows.map((r) => Object.fromEntries(section.columnKeys.map((k, i) => [k, r[i] ?? ""])));
}

export const COL = {
  time: "report.col.time",
  visitNo: "report.col.visitNo",
  uhid: "report.col.uhid",
  patient: "report.col.patient",
  type: "report.col.type",
  status: "report.col.status",
  outcome: "report.col.outcome",
  mode: "report.col.mode",
  amount: "report.col.amount",
} as const;

export type VisitSummary = { total: number; waiting: number; registered: number; withDoctor: number; done: number; left: number; first: string | null; last: string | null };

export function summariseVisits(rows: ReportRow[]): VisitSummary {
  const n = (t: StatusTone): number => rows.filter((r) => statusTone(r[COL.status] ?? "") === t).length;
  const times = rows.map((r) => r[COL.time] ?? "").filter((t) => t !== "").sort();
  return {
    total: rows.length, registered: n("reg"), waiting: n("wait"), withDoctor: n("doc"), done: n("done"), left: n("left"),
    first: times[0] ?? null, last: times[times.length - 1] ?? null,
  };
}

/** A desk card's stat by key — the desk is where live counts that are not report rows come from. */
export function deskStat(desk: WireDesk | undefined, cardKey: string, statKey: string): string | null {
  const card = desk?.cards.find((c) => c.key === cardKey);
  return card?.stats?.find((s) => s.key === statKey)?.value ?? null;
}

export function hasCard(desk: WireDesk | undefined, cardKey: string): boolean {
  return desk?.cards.some((c) => c.key === cardKey) ?? false;
}

/** "₹41,300.00" / "86" → 41300 / 86. Only used to derive a percentage between two server figures. */
export function figure(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && s.match(/[0-9]/) !== null ? n : null;
}

export type Metric = {
  fact: string;
  total: string;
  median?: string;
  /** Signed whole percent of total vs median, when both are figures and the median is not zero. */
  deltaPct?: number;
  first?: string;
  second?: string;
};

/**
 * The brief's clauses, regrouped by FACT. A clause key is `brief.<fact>.<plain|compared|drift>`;
 * the scoreboard shows one row per fact with the total big and the comparison beside it.
 */
export function metricsOf(brief: WireBrief | undefined): Metric[] {
  const out: Metric[] = [];
  for (const c of brief?.clauses ?? []) {
    const m = /^brief\.([a-zA-Z]+)\.(plain|compared|drift)$/.exec(c.key);
    if (m === null) continue;
    const fact = m[1]!;
    let row = out.find((x) => x.fact === fact);
    if (row === undefined) { row = { fact, total: c.values.total ?? "" }; out.push(row); }
    if (m[2] === "compared" && c.values.median !== undefined) {
      row.median = c.values.median;
      const t = figure(c.values.total); const md = figure(c.values.median);
      if (t !== null && md !== null && md !== 0) row.deltaPct = Math.round(((t - md) / md) * 100);
    }
    if (m[2] === "drift") { row.first = c.values.first; row.second = c.values.second; }
  }
  return out;
}

/** ISO date ± days, on the calendar (no clock involved). */
export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function longDate(iso: string, lang: string, withYear = true): string {
  const d = new Date(`${iso}T12:00:00.000Z`);
  const s = d.toLocaleDateString(lang.startsWith("hi") ? "hi-IN" : "en-GB", {
    weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });
  // Node/Chromium's en-GB writes "Sept" (see lib/snippets.ts); the hospital writes "Sep".
  return s.replace(/\bSept\b/, "Sep").replace(/^(\w{3}) (\d)/, "$1, $2");
}
