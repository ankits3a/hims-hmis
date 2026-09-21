import { RosterError } from "./errors";

/**
 * PHASE R (R3) — **THE INTERN YEAR WRITES ITSELF.**
 *
 * ═══ WHY THIS IS GENERATED AND NOT TYPED ═══
 *
 * A compulsory rotating medical internship is 52 weeks, and the CRMI 2021 regulations fix the
 * weeks per department exactly. A hospital with 150 seats admits 150 interns a year, staggered into
 * sub-batches so that every department has interns every week — which is ~150 × 14 postings a year,
 * each with a start date, an end date and a department. Typed by hand it is wrong within a month,
 * and being wrong means a ward has nobody on a morning nobody noticed.
 *
 * So the table below IS the regulation, and everything else is arithmetic over it. The functions
 * here are **pure** — no database, no clock — which is what lets V17 assert the two properties that
 * matter (it sums to 52 weeks; an over-limit absence is repeated where it happened) without a
 * fixture.
 *
 * ═══ THE 15 DAYS, AND WHAT HAPPENS AFTER THEM ═══
 *
 * CRMI allows **15 days' leave in the year**. Beyond that, *"absence is repeated in the department
 * where it occurred"* — not added to the end as generic time, and not forgiven. That distinction is
 * the whole of `extensionPostings`, and it is the thing a hand-written plan always gets wrong,
 * because the natural implementation extends the internship by the excess and puts the intern
 * wherever there is room.
 */

export interface CrmiBlock {
  departmentCode: string;
  weeks: number;
  /** Community Medicine is served at a rural or urban health centre, away from the hospital. */
  external?: boolean;
  /** Elective time the intern chooses; the department is decided later, so it has no code yet. */
  elective?: boolean;
}

/**
 * CRMI 2021, transcribed. **52 weeks**, and the order is the order the regulation lists them in
 * rather than an order anybody optimised — the stagger below is what spreads sub-batches out, and
 * re-ordering this table to achieve that would make it stop being a transcription.
 */
export const CRMI_TABLE: readonly CrmiBlock[] = [
  { departmentCode: "COMM", weeks: 12, external: true },
  { departmentCode: "MED", weeks: 6 },
  { departmentCode: "SUR", weeks: 6 },
  { departmentCode: "OBG", weeks: 7 },
  { departmentCode: "PED", weeks: 3 },
  { departmentCode: "ORT", weeks: 2 },
  { departmentCode: "ENT", weeks: 2 },
  { departmentCode: "OPH", weeks: 2 },
  { departmentCode: "PSY", weeks: 2 },
  { departmentCode: "ANAE", weeks: 2 },
  { departmentCode: "CAS", weeks: 2 },
  { departmentCode: "DER", weeks: 1 },
  { departmentCode: "FMT", weeks: 1 },
  { departmentCode: "ELECTIVE", weeks: 4, elective: true },
];

export const CRMI_TOTAL_WEEKS = 52;
export const CRMI_LEAVE_DAYS = 15;
/**
 * No single posting runs longer than seven weeks. Community Medicine's twelve is therefore served
 * in two blocks — which is also how it is actually done, because the health centre takes a fresh
 * group every six weeks rather than holding one for three months.
 */
export const MAX_BLOCK_WEEKS = 7;

export interface InternPosting {
  departmentCode: string;
  /** `[startIstDate, endIstDate)` — half-open, so one posting's end is the next one's start. */
  startIstDate: string;
  endIstDate: string;
  days: number;
  external: boolean;
  elective: boolean;
  /** TRUE when this posting exists because the intern was absent beyond the allowance. */
  extension: boolean;
}

/* ═══════════════════════════════ date arithmetic, in plain days ═══════════════════════════════ */

const DAY_MS = 86_400_000;

function assertIstDate(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new RosterError("intern_plan_invalid", `"${d}" is not a calendar day`, { date: d });
  }
}

const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Splits a block longer than `MAX_BLOCK_WEEKS` into near-equal pieces. Twelve becomes 6 + 6 rather
 * than 7 + 5: an intern who spends seven weeks at a health centre and five at another has had two
 * different postings, and the centres plan in equal groups.
 */
export function splitBlock(weeks: number): number[] {
  if (weeks <= MAX_BLOCK_WEEKS) return [weeks];
  const pieces = Math.ceil(weeks / MAX_BLOCK_WEEKS);
  const base = Math.floor(weeks / pieces);
  const extra = weeks - base * pieces;
  return Array.from({ length: pieces }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Every block of the year, in regulation order, with long ones split. */
export function crmiBlocks(): CrmiBlock[] {
  return CRMI_TABLE.flatMap((b) =>
    splitBlock(b.weeks).map((weeks) => ({ ...b, weeks })));
}

export interface InternYearInput {
  /** The day the batch starts, IST, as `YYYY-MM-DD`. */
  batchStartIstDate: string;
  /** Which sub-batch this intern is in, zero-based. */
  subBatch?: number;
  /** How many sub-batches the year is staggered across. */
  subBatches?: number;
}

/**
 * ═══ THE STAGGER IS WHY SUB-BATCHES EXIST ═══
 *
 * Every sub-batch works the same blocks in the same order — **rotated**. Sub-batch 0 starts at
 * Community Medicine, sub-batch 1 starts where sub-batch 0's second block is, and so on. The effect
 * is that on any given week the sub-batches are spread across different departments, which is the
 * property the hospital actually needs: *every department has interns every week.* A batch that all
 * moved together would leave Medicine with none for twelve weeks.
 */
export function internYear(input: InternYearInput): InternPosting[] {
  assertIstDate(input.batchStartIstDate);
  const subBatches = input.subBatches ?? 1;
  const subBatch = input.subBatch ?? 0;
  if (!Number.isInteger(subBatches) || subBatches < 1) {
    throw new RosterError("intern_plan_invalid", "a year is staggered across at least one sub-batch", { subBatches });
  }
  if (!Number.isInteger(subBatch) || subBatch < 0 || subBatch >= subBatches) {
    throw new RosterError("intern_plan_invalid", `sub-batch ${subBatch} is not one of ${subBatches}`, { subBatch, subBatches });
  }

  const blocks = crmiBlocks();
  const shift = Math.round((subBatch * blocks.length) / subBatches) % blocks.length;
  const ordered = [...blocks.slice(shift), ...blocks.slice(0, shift)];

  let cursor = input.batchStartIstDate;
  return ordered.map((b) => {
    const days = b.weeks * 7;
    const startIstDate = cursor;
    const endIstDate = addDays(cursor, days);
    cursor = endIstDate;
    return {
      departmentCode: b.departmentCode, startIstDate, endIstDate, days,
      external: b.external ?? false, elective: b.elective ?? false, extension: false,
    };
  });
}

export interface InternAbsence {
  departmentCode: string;
  days: number;
}

/**
 * ═══ AN OVER-LIMIT ABSENCE IS REPEATED WHERE IT HAPPENED ═══
 *
 * The 15 days are ONE pool for the year, consumed in the order the absences occurred. What is left
 * over is owed **to the department it was taken from** — an intern who missed three weeks of
 * Paediatrics repeats Paediatrics, not whichever ward has a gap. The postings are appended after
 * the year's last block, in the order the shortfalls arose.
 *
 * Returns only the EXTENSION postings; the caller appends them. That way "did this intern need an
 * extension?" is answerable without diffing two plans.
 */
export function extensionPostings(
  plan: readonly InternPosting[],
  absences: readonly InternAbsence[],
  allowanceDays = CRMI_LEAVE_DAYS,
): InternPosting[] {
  if (plan.length === 0) return [];
  let allowance = allowanceDays;
  const owed: { departmentCode: string; days: number }[] = [];

  for (const a of absences) {
    if (a.days <= 0) continue;
    const covered = Math.min(allowance, a.days);
    allowance -= covered;
    const excess = a.days - covered;
    if (excess === 0) continue;
    const already = owed.find((o) => o.departmentCode === a.departmentCode);
    if (already === undefined) owed.push({ departmentCode: a.departmentCode, days: excess });
    else already.days += excess;
  }

  let cursor = plan[plan.length - 1]!.endIstDate;
  return owed.map((o) => {
    const startIstDate = cursor;
    const endIstDate = addDays(cursor, o.days);
    cursor = endIstDate;
    const source = plan.find((p) => p.departmentCode === o.departmentCode);
    return {
      departmentCode: o.departmentCode, startIstDate, endIstDate, days: o.days,
      external: source?.external ?? false, elective: false, extension: true,
    };
  });
}

/** The regulation's own arithmetic, so a transcription error in `CRMI_TABLE` is loud. */
export function crmiWeeksTotal(): number {
  return CRMI_TABLE.reduce((n, b) => n + b.weeks, 0);
}
