import { and, eq, gte, lt, sql } from "drizzle-orm";
import { BMW_REPORT_LINES } from "@hmis/contracts";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { bmwBags, bmwDisputes } from "../../kernel/db/schema";
import { toCsv } from "../../kernel/report/csv";
import { BmwError } from "./errors";
import type { BmwFormIvReport, BmwMonthlyReport, BmwReportLine } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE LEGAL REPORTS, READ OFF THE BAG ROWS — NO TYPING ═══
 *
 * Monthly report (the register the pollution control board inspects) and the annual report's Form IV figures
 * (BMW Rules 2016 r.13: quantity of waste by category). Every number is a SUM over `bmw_bags`; nothing here is
 * entered by hand, so the report and the bags cannot disagree.
 *
 *   generated   — bags whose `generated_at` falls in the period; weight = the department's.
 *   handed over — bags whose `handed_over_at` falls in the period; weight = the central store's (department's if absent).
 *   treated     — bags whose `treated_at` falls in the period (the facility's receipt, disputed or not); weight = the facility's.
 *
 * Periods are IST calendar months. `yellow_cytotoxic` is the cytotoxic part of yellow: shown, never added to totals.
 */
/** 00:00 IST on the 1st: the IST day window around noon UTC of the 1st (the kernel clock, no copy of its offset). */
const istMonthStart = (year: number, month1: number): Date => istDayWindow(new Date(Date.UTC(year, month1 - 1, 1, 12))).start;

type LineKey = BmwReportLine["line"];
const lineOf = (category: string, cytotoxic: boolean): LineKey[] =>
  category === "yellow" && cytotoxic ? ["yellow", "yellow_cytotoxic"] : [category as LineKey];

function parseMonth(month: string): { year: number; m: number } {
  const hit = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (hit === null) throw new BmwError("bad_period", { month });
  return { year: Number(hit[1]), m: Number(hit[2]) };
}

type Sum = { bags: number; grams: number };
async function sumBy(
  db: Db, column: typeof bmwBags.generatedAt | typeof bmwBags.handedOverAt | typeof bmwBags.treatedAt,
  weight: ReturnType<typeof sql<number>>, from: Date, to: Date,
): Promise<Map<LineKey, Sum>> {
  const rows = await db.select({
    category: bmwBags.category, cytotoxic: bmwBags.cytotoxic,
    bags: sql<number>`count(*)::int`, grams: sql<number>`coalesce(sum(${weight}), 0)::int`,
  }).from(bmwBags).where(and(gte(column, from), lt(column, to))).groupBy(bmwBags.category, bmwBags.cytotoxic);
  const out = new Map<LineKey, Sum>();
  for (const r of rows) {
    for (const line of lineOf(r.category, r.cytotoxic)) {
      const s = out.get(line) ?? { bags: 0, grams: 0 };
      s.bags += r.bags;
      s.grams += r.grams;
      out.set(line, s);
    }
  }
  return out;
}

export async function monthlyReport(db: Db, month: string): Promise<BmwMonthlyReport> {
  const { year, m } = parseMonth(month);
  const from = istMonthStart(year, m);
  const to = m === 12 ? istMonthStart(year + 1, 1) : istMonthStart(year, m + 1);
  const generated = await sumBy(db, bmwBags.generatedAt, sql<number>`${bmwBags.deptWeightGrams}`, from, to);
  const handed = await sumBy(db, bmwBags.handedOverAt, sql<number>`coalesce(${bmwBags.centralWeightGrams}, ${bmwBags.deptWeightGrams})`, from, to);
  const treated = await sumBy(db, bmwBags.treatedAt, sql<number>`${bmwBags.cbwtfWeightGrams}`, from, to);
  const zero: Sum = { bags: 0, grams: 0 };
  const lines: BmwReportLine[] = BMW_REPORT_LINES.map((line) => ({
    line, subsetOf: line === "yellow_cytotoxic" ? "yellow" : null,
    generatedBags: (generated.get(line) ?? zero).bags, generatedGrams: (generated.get(line) ?? zero).grams,
    handedOverBags: (handed.get(line) ?? zero).bags, handedOverGrams: (handed.get(line) ?? zero).grams,
    treatedBags: (treated.get(line) ?? zero).bags, treatedGrams: (treated.get(line) ?? zero).grams,
  }));
  const counted = lines.filter((l) => l.subsetOf === null);
  const total = (k: keyof Omit<BmwReportLine, "line" | "subsetOf">): number => counted.reduce((n, l) => n + l[k], 0);
  const unweighed = (await db.select({ n: sql<number>`count(*)::int` }).from(bmwBags)
    .where(and(gte(bmwBags.generatedAt, from), lt(bmwBags.generatedAt, to), sql`${bmwBags.deptWeightGrams} is null`)))[0]!.n;
  const openDisputes = (await db.select({ n: sql<number>`count(*)::int` }).from(bmwDisputes).where(eq(bmwDisputes.state, "open")))[0]!.n;
  return {
    month, lines,
    totals: {
      generatedBags: total("generatedBags"), generatedGrams: total("generatedGrams"),
      handedOverBags: total("handedOverBags"), handedOverGrams: total("handedOverGrams"),
      treatedBags: total("treatedBags"), treatedGrams: total("treatedGrams"),
    },
    unweighedBags: unweighed, openDisputes,
  };
}

/**
 * Form IV figures: grams GENERATED per line per IST month of the year, the annual sums, and the average per day —
 * over the whole year once it has ended, over the days so far (IST, today included) while it runs.
 */
export async function formIvReport(db: Db, year: string, now: Date = new Date()): Promise<BmwFormIvReport> {
  if (!/^\d{4}$/.test(year)) throw new BmwError("bad_period", { year });
  const y = Number(year);
  const blank = (): Record<LineKey, number> => Object.fromEntries(BMW_REPORT_LINES.map((l) => [l, 0])) as Record<LineKey, number>;
  const months: BmwFormIvReport["months"] = [];
  const annual = blank();
  for (let m = 1; m <= 12; m += 1) {
    const from = istMonthStart(y, m);
    const to = m === 12 ? istMonthStart(y + 1, 1) : istMonthStart(y, m + 1);
    const sums = await sumBy(db, bmwBags.generatedAt, sql<number>`${bmwBags.deptWeightGrams}`, from, to);
    const grams = blank();
    for (const line of BMW_REPORT_LINES) {
      grams[line] = sums.get(line)?.grams ?? 0;
      annual[line] += grams[line];
    }
    months.push({ month: `${year}-${String(m).padStart(2, "0")}`, grams });
  }
  const start = istMonthStart(y, 1);
  const end = istMonthStart(y + 1, 1);
  const days = now >= end ? Math.round((end.getTime() - start.getTime()) / 86_400_000)
    : now < start ? 0 : Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1;
  const annualTotalGrams = BMW_REPORT_LINES.filter((l) => l !== "yellow_cytotoxic").reduce((n, l) => n + annual[l], 0);
  return { year, months, annualGrams: annual, annualTotalGrams, averageGramsPerDay: days === 0 ? 0 : Math.round(annualTotalGrams / days), days };
}

const LINE_NAMES: Record<LineKey, string> = {
  yellow: "Yellow", yellow_cytotoxic: "  of which cytotoxic", red: "Red", white_translucent: "White (translucent)", blue: "Blue",
};
const kg = (g: number): string => (g / 1000).toFixed(3);

export function monthlyReportCsv(r: BmwMonthlyReport): string {
  const head = ["Category", "Bags generated", "kg generated", "Bags handed over", "kg handed over", "Bags treated", "kg treated"];
  const row = (name: string, l: Omit<BmwReportLine, "line" | "subsetOf">): string[] => [
    name, String(l.generatedBags), kg(l.generatedGrams), String(l.handedOverBags), kg(l.handedOverGrams), String(l.treatedBags), kg(l.treatedGrams),
  ];
  return toCsv([head, ...r.lines.map((l) => row(LINE_NAMES[l.line], l)), row("Total", r.totals)]);
}

export function formIvCsv(r: BmwFormIvReport): string {
  const head = ["Category", ...r.months.map((m) => m.month), "Total kg"];
  const rows = BMW_REPORT_LINES.map((line) => [LINE_NAMES[line], ...r.months.map((m) => kg(m.grams[line])), kg(r.annualGrams[line])]);
  const totals = ["Total", ...r.months.map((m) => kg(BMW_REPORT_LINES.filter((l) => l !== "yellow_cytotoxic").reduce((n, l) => n + m.grams[l], 0))), kg(r.annualTotalGrams)];
  return toCsv([head, ...rows, totals, ["Average kg per day", kg(r.averageGramsPerDay)], ["Days", String(r.days)]]);
}
