import { formatPaise } from "../report/money";
import { addDays, sumWindow } from "./rollup";
import type { DayFacts } from "./rollup";

/**
 * PLAN 07c T8 / DD12 — THE BRIEF: EVERY SENTENCE GENERATED FROM TYPED FACTS, NEVER AUTHORED.
 *
 * There is no model in this file and there will not be one. A sentence a person reads about their
 * own week has to be REPRODUCIBLE — the same facts must give the same words, forever, so that a
 * clause can be argued with and a figure can be traced. That is a template, and templates are
 * testable: every clause below is a pure function of numbers, and the tests can enumerate them.
 *
 * ═══ DD8, WHICH IS THE HARD PART AND THE WHOLE POINT ═══
 *
 * **NO METRIC WITHOUT AN HONEST BASELINE.** A comparison needs something to compare against, and on
 * a person's second day there is nothing. The temptation is to print "0% vs median", which is not a
 * neutral placeholder — it is a FABRICATED comparison that reads exactly like a real one, and a
 * supervisor cannot tell them apart. So a clause with no baseline is OMITTED, and the brief is
 * shorter. A short honest brief is the correct output of a thin history.
 *
 * `MIN_BASELINE_DAYS` is the count of days that must actually carry the fact — not the count of
 * days in the window. A fortnight in which somebody worked twice is two days of evidence.
 *
 * ═══ SHORT PERIODS COMPARE, LONG PERIODS DRIFT ═══
 *
 * A day is compared against the SAME WEEKDAY, because a Tuesday counter and a Saturday counter are
 * different jobs at an Indian hospital and comparing them manufactures a fall every weekend. A week
 * is compared against the prior week. Three and six months carry DRIFT instead — first half against
 * second half — because that is the only thing a long window tells you that a single day cannot,
 * and re-stating "vs the previous six months" would need a year of history nobody has yet.
 */
export const MIN_BASELINE_DAYS = 14;

export type Period = "day" | "week" | "month" | "quarter" | "half";

export const PERIODS: readonly Period[] = ["day", "week", "month", "quarter", "half"];

/** How many days each period spans, ending today (inclusive). */
const SPAN: Record<Period, number> = { day: 1, week: 7, month: 30, quarter: 91, half: 183 };

export function windowFor(period: Period, today: string): { from: string; to: string } {
  return { from: addDays(today, -(SPAN[period] - 1)), to: today };
}

/**
 * The BASELINE window for a period: the stretch immediately before it, of the same length. For a
 * DAY this is deliberately not "yesterday" — see `sameWeekdayBaseline`.
 */
export function baselineWindowFor(period: Period, today: string): { from: string; to: string } {
  const span = SPAN[period];
  return { from: addDays(today, -(span * 2 - 1)), to: addDays(today, -span) };
}

export type Clause = {
  /** An i18n key. The SERVER decides which clauses are honest; the client renders the words. */
  key: string;
  /** Interpolation values, pre-formatted. Never `count` — `billing-office.tsx` documents why. */
  values: Record<string, string>;
};

export type Brief = {
  period: Period;
  from: string;
  to: string;
  /** Every clause that could be made honestly. An empty list is a real and correct answer. */
  clauses: Clause[];
  /** The headline figures, so the screen need not re-derive them from the clauses. */
  totals: Record<string, number>;
  /** How many days of the window carried any fact at all — the brief's own evidence count. */
  daysWithActivity: number;
};

/** The median of a list, or null when there is not enough of it to be honest about (DD8). */
export function medianOf(values: number[], minDays = MIN_BASELINE_DAYS): number | null {
  if (values.length < minDays) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * A day is compared against the SAME WEEKDAY in the baseline, never against every day in it.
 *
 * At an Indian hospital a Saturday OPD is a different shape of day from a Tuesday one and Sunday is
 * often no day at all. Comparing a Saturday against a pooled weekday median manufactures a collapse
 * every weekend and a surge every Monday, and a person reading their own brief learns to ignore it —
 * which is worse than having no comparison, because the ignoring generalises.
 */
function sameWeekdayBaseline(days: DayFacts[], today: string, key: string): number[] {
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  return days
    .filter((d) => new Date(`${d.day}T00:00:00.000Z`).getUTCDay() === weekday)
    .map((d) => d.facts[key])
    .filter((v): v is number => v !== undefined);
}

function presentValues(days: DayFacts[], key: string): number[] {
  return days.map((d) => d.facts[key]).filter((v): v is number => v !== undefined);
}

/** Which facts a brief speaks about, and how each one is worded. Money renders as rupees. */
const SPOKEN: { fact: string; clause: string; money?: boolean }[] = [
  { fact: "opd.patientsRegistered", clause: "brief.registered" },
  { fact: "opd.visitsOpened", clause: "brief.visits" },
  { fact: "opd.consultsCompleted", clause: "brief.consults" },
  { fact: "opd.vitalsRecorded", clause: "brief.vitals" },
  { fact: "opd.appointmentsBooked", clause: "brief.appointments" },
  { fact: "billing.receipts", clause: "brief.receipts" },
  { fact: "billing.collectedPaise", clause: "brief.collected", money: true },
];

const show = (value: number, money: boolean | undefined): string =>
  money === true ? formatPaise(value) : String(value);

/**
 * PLAN 07c T8 — the brief, built.
 *
 * `days` is the window itself; `baseline` is the stretch before it, already read. Both are plain
 * data, so this function is pure and every clause it emits is enumerable in a test — which is the
 * property DD12 is actually asking for when it says the sentence is generated rather than authored.
 */
export function buildBrief(
  period: Period, today: string, days: DayFacts[], baseline: DayFacts[],
): Brief {
  const { from, to } = windowFor(period, today);
  const totals = sumWindow(days);
  const clauses: Clause[] = [];

  for (const spec of SPOKEN) {
    const total = totals[spec.fact];
    if (total === undefined) continue; // no module contributed it — say nothing at all
    const values: Record<string, string> = { total: show(total, spec.money) };

    if (period === "day" || period === "week") {
      /*
       * SHORT PERIODS CARRY A COMPARISON. The baseline is per-day for a day and per-window for a
       * week; either way `medianOf` returns null when the evidence is thin, and the clause then
       * ships as a plain count. That null is DD8 enforced in one place rather than remembered in
       * seven.
       */
      const sample = period === "day"
        ? sameWeekdayBaseline(baseline, today, spec.fact)
        : presentValues(baseline, spec.fact);
      const median = medianOf(sample, period === "day" ? 4 : MIN_BASELINE_DAYS);
      if (median !== null) {
        values.median = show(median, spec.money);
        clauses.push({ key: `${spec.clause}.compared`, values });
        continue;
      }
    } else {
      /*
       * LONG PERIODS CARRY DRIFT — the window's own first half against its own second half. It
       * needs no history beyond the window itself, which is why a six-month brief can say something
       * true in a hospital that has been running for six months and one day.
       */
      /**
       * ═══ THE TWO HALVES ARE THE SAME LENGTH, AND THE MIDDLE DAY IS DROPPED TO MAKE THEM SO ═══
       *
       * The obvious split — `slice(0, half)` against `slice(half)` — is WRONG on an odd-length
       * window, and both of the long periods are odd: a quarter is 91 days and a half is 183. It
       * puts 45 days on one side and 46 on the other, so a person whose workload never changed at
       * all reads "up" on every quarterly and six-monthly brief they ever open. A test caught it
       * with three visits a day for 91 days, which should be the flattest possible input.
       *
       * That is exactly DD9's failure mode — a plausible wrong number is worse than a missing one —
       * and the direction of the error is the damaging one: it silently flatters everybody.
       */
      const half = Math.floor(days.length / 2);
      if (days.length >= 2 && half > 0) {
        const first = sumWindow(days.slice(0, half))[spec.fact];
        const second = sumWindow(days.slice(days.length - half))[spec.fact];
        if (first !== undefined && second !== undefined && first > 0) {
          values.first = show(first, spec.money);
          values.second = show(second, spec.money);
          values.direction = second > first ? "up" : second < first ? "down" : "flat";
          clauses.push({ key: `${spec.clause}.drift`, values });
          continue;
        }
      }
    }
    clauses.push({ key: `${spec.clause}.plain`, values });
  }

  return {
    period, from, to, clauses, totals,
    daysWithActivity: days.filter((d) => Object.values(d.facts).some((v) => v > 0)).length,
  };
}
