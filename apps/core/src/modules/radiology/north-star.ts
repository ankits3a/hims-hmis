import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { imagingReportDelivery, imagingReports, imagingStudies } from "../../kernel/db/schema/radiology";
import { orders } from "../../kernel/db/schema/orders";
import { EPISODE_SERIES } from "../../kernel/episodes/series";
import { RadiologyError } from "./errors";
import { activeStudyTypes } from "./study-types";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 18-S RS9 T2 — THE NORTH STAR: ORDER → REPORT ACTED UPON ═══
 *
 * *Right patient, safe scan, fast read, closed loop.* The one number is the time from the order to
 * the treating doctor recording what the report changed. This read model answers it per modality
 * and per source, over columns that already exist plus RS9's `acted_*`:
 *
 *   · ordered            — studies whose ORDER was placed in the window (`orders.placed_at`, IST
 *                          days). A `rescheduled` row is excluded: a reschedule writes a new study
 *                          row and closes the old one, so counting both would count one order twice.
 *   · order → signed     — to the FIRST signature (the reading room's turnaround; an amendment does
 *                          not move it).
 *   · signed → first read, order → acted — on the CURRENT released version (an amendment re-opens
 *                          the loop, so the clock reads the version the doctor must act on).
 *   · signed-unread > 24 h, published-not-acted > 72 h — counted at `now`.
 *
 * Median and 90th percentile by the nearest-rank method over whole minutes. Pure TS over one query.
 *
 * **Source (DECIDED, until IPD and ER modules exist):** `OUT` when the order's authority is an
 * outside prescription or the patient themself (no in-house treating doctor); `IPD` for a day-care
 * (`D…`) encounter or a bedside study; `ER` for a STAT order; `OPD` otherwise. First match wins.
 */

export const NORTH_STAR_SOURCES = ["OPD", "IPD", "ER", "OUT"] as const;
export type NorthStarSource = (typeof NORTH_STAR_SOURCES)[number];
export const UNREAD_ALERT_HOURS = 24;
export const NOT_ACTED_ALERT_HOURS = 72;
/** A window longer than this is refused: the read is one query held in memory. */
export const NORTH_STAR_MAX_DAYS = 366;

export type Percentiles = { n: number; medianMin: number | null; p90Min: number | null };

export type NorthStarRow = {
  modality: string;
  source: NorthStarSource;
  ordered: number;
  orderToSigned: Percentiles;
  signedToFirstRead: Percentiles;
  orderToActed: Percentiles;
  signedUnreadOver24h: number;
  publishedNotActedOver72h: number;
};

export type NorthStar = {
  from: string;
  to: string;
  generatedAt: string;
  rows: NorthStarRow[];
  total: Omit<NorthStarRow, "modality" | "source">;
};

/** Nearest-rank percentile of whole minutes. Empty → nulls, never a zero that reads as "instant". */
export function percentiles(minutes: readonly number[]): Percentiles {
  if (minutes.length === 0) return { n: 0, medianMin: null, p90Min: null };
  const s = [...minutes].sort((a, b) => a - b);
  const rank = (p: number): number => s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, medianMin: rank(0.5), p90Min: rank(0.9) };
}

export function sourceOf(input: {
  authority: string; encounterNo: string; bedsideLocation: string | null; priority: string;
}): NorthStarSource {
  if (input.authority === "external_prescription" || input.authority === "self") return "OUT";
  if (input.encounterNo.startsWith(EPISODE_SERIES.daycare) || input.bedsideLocation !== null) return "IPD";
  if (input.priority === "stat") return "ER";
  return "OPD";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** An IST calendar day's first instant. */
function istStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+05:30`);
}

const minutesBetween = (a: Date, b: Date): number => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

export async function northStar(
  db: Db,
  input: { from: string; to: string; now?: Date },
): Promise<NorthStar> {
  const now = input.now ?? new Date();
  if (!DAY_RE.test(input.from) || !DAY_RE.test(input.to)) {
    throw new RadiologyError("invalid_date", "from and to are calendar days, YYYY-MM-DD");
  }
  const start = istStart(input.from);
  const endExclusive = new Date(istStart(input.to).getTime() + 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive <= start) {
    throw new RadiologyError("invalid_date", "the window must run forwards: from on or before to");
  }
  if (endExclusive.getTime() - start.getTime() > NORTH_STAR_MAX_DAYS * 86_400_000) {
    throw new RadiologyError("invalid_date", `a window is at most ${String(NORTH_STAR_MAX_DAYS)} days`);
  }

  const studies = await db
    .select({
      id: imagingStudies.id, studyTypeCode: imagingStudies.studyTypeCode, encounterNo: imagingStudies.encounterNo,
      bedsideLocation: imagingStudies.bedsideLocation, priority: imagingStudies.priority,
      placedAt: orders.placedAt, authority: orders.authority,
    })
    .from(imagingStudies)
    .innerJoin(orders, eq(orders.id, imagingStudies.orderId))
    .where(and(
      gte(orders.placedAt, start), lt(orders.placedAt, endExclusive),
      ne(imagingStudies.status, "rescheduled"),
    ));

  const ids = studies.map((s) => s.id);
  const reports = ids.length === 0 ? [] : await db
    .select({
      studyId: imagingReports.studyId, status: imagingReports.status, signedAt: imagingReports.signedAt,
      publishedAt: imagingReports.publishedAt,
      firstReadAt: imagingReportDelivery.firstReadAt, actedAt: imagingReportDelivery.actedAt,
    })
    .from(imagingReports)
    .leftJoin(imagingReportDelivery, eq(imagingReportDelivery.reportId, imagingReports.id))
    .where(and(inArray(imagingReports.studyId, ids), inArray(imagingReports.status, ["signed", "superseded"])));

  const firstSigned = new Map<string, Date>();
  const current = new Map<string, { signedAt: Date | null; publishedAt: Date | null; firstReadAt: Date | null; actedAt: Date | null }>();
  for (const r of reports) {
    if (r.signedAt !== null) {
      const prev = firstSigned.get(r.studyId);
      if (prev === undefined || r.signedAt < prev) firstSigned.set(r.studyId, r.signedAt);
    }
    if (r.status === "signed") {
      current.set(r.studyId, { signedAt: r.signedAt, publishedAt: r.publishedAt, firstReadAt: r.firstReadAt, actedAt: r.actedAt });
    }
  }

  /** The book's modality for a study type; a code the active book no longer carries reads `other`. */
  let modalityOf: (code: string) => string = () => "other";
  try {
    const types = await activeStudyTypes(db);
    const by = new Map(types.map((t) => [t.code, t.modality as string]));
    modalityOf = (code) => by.get(code) ?? "other";
  } catch {
    /** No active book: every row is `other` rather than no answer at all. */
  }

  type Acc = { ordered: number; o2s: number[]; s2r: number[]; o2a: number[]; unread: number; notActed: number };
  const groups = new Map<string, Acc>();
  const total: Acc = { ordered: 0, o2s: [], s2r: [], o2a: [], unread: 0, notActed: 0 };
  const unreadCut = now.getTime() - UNREAD_ALERT_HOURS * 3_600_000;
  const actedCut = now.getTime() - NOT_ACTED_ALERT_HOURS * 3_600_000;

  for (const s of studies) {
    const key = `${modalityOf(s.studyTypeCode)}|${sourceOf(s)}`;
    let g = groups.get(key);
    if (g === undefined) { g = { ordered: 0, o2s: [], s2r: [], o2a: [], unread: 0, notActed: 0 }; groups.set(key, g); }
    const add = (f: (a: Acc) => void): void => { f(g!); f(total); };
    add((a) => { a.ordered += 1; });
    const fs = firstSigned.get(s.id);
    if (fs !== undefined) { const m = minutesBetween(s.placedAt, fs); add((a) => { a.o2s.push(m); }); }
    const c = current.get(s.id);
    if (c !== undefined && c.publishedAt !== null) {
      if (c.signedAt !== null && c.firstReadAt !== null) {
        const m = minutesBetween(c.signedAt, c.firstReadAt); add((a) => { a.s2r.push(m); });
      }
      if (c.actedAt !== null) { const m = minutesBetween(s.placedAt, c.actedAt); add((a) => { a.o2a.push(m); }); }
      if (c.firstReadAt === null && c.publishedAt.getTime() < unreadCut) add((a) => { a.unread += 1; });
      if (c.actedAt === null && c.publishedAt.getTime() < actedCut) add((a) => { a.notActed += 1; });
    }
  }

  const shape = (a: Acc): Omit<NorthStarRow, "modality" | "source"> => ({
    ordered: a.ordered,
    orderToSigned: percentiles(a.o2s),
    signedToFirstRead: percentiles(a.s2r),
    orderToActed: percentiles(a.o2a),
    signedUnreadOver24h: a.unread,
    publishedNotActedOver72h: a.notActed,
  });
  const rows: NorthStarRow[] = [...groups.entries()].map(([k, a]) => {
    const [modality, source] = k.split("|") as [string, NorthStarSource];
    return { modality, source, ...shape(a) };
  }).sort((x, y) => x.modality.localeCompare(y.modality)
    || NORTH_STAR_SOURCES.indexOf(x.source) - NORTH_STAR_SOURCES.indexOf(y.source));

  return { from: input.from, to: input.to, generatedAt: now.toISOString(), rows, total: shape(total) };
}
