import { and, eq, sql } from "drizzle-orm";
import { episodeSeries } from "../db/schema";
import type { Tx } from "../db/client";

/**
 * THE EPISODE-NUMBER VOCABULARY (owner ruling 2026-08-25). One letter per document type — with ONE
 * deliberate exception, `grn`, added by Plan 14 T1 and explained at its entry below — and the
 * map is CODE-owned rather than config: unlike the UHID prefix — which is hospital identity and
 * printed on every card — these letters are an internal grammar that every module must agree on,
 * and a per-deployment override would only create hospitals whose lab forms cannot be read by
 * anyone else's software.
 *
 * `lab_order` vs `lab_specimen` is not redundancy and is the entry most likely to be "simplified"
 * away by whoever writes the lab plan. An ORDER is what the doctor asked for ("CBC + LFT"); a
 * SPECIMEN is the physical tube that reached the bench. One order yields several tubes and one
 * tube serves several tests, so a single number cannot express a haemolysed sample being rejected
 * and redrawn without cancelling the whole order. The letters are reserved here so those modules
 * inherit this grammar instead of inventing one each.
 */
export const EPISODE_SERIES = {
  visit: "V",
  appointment: "A",
  lab_order: "L",
  lab_specimen: "S",
  radiology_order: "R",
  pharmacy_dispense: "P",
  /**
   * PLAN 14 T1 — THE ONE MULTI-LETTER PREFIX, and the exception is stated rather than smuggled.
   *
   * Every other entry is a single letter because every other entry names a CLINICAL document a
   * patient carries: a visit slip, a lab form, a prescription. A GRN is a STORES document, it is
   * read by a storekeeper and a vendor and never by a patient, and `G` alone collides with nothing
   * today only by luck — `gate pass`, `gas cylinder log` and `glucometer QC` are all in doc 09's
   * own §14 sketch and all of them want it. Three letters cost the width nothing: `formatEpisodeNo`
   * pads the SERIAL to four digits and the prefix is free-form, so `GRN2608270001` parses exactly as
   * `V2608270001` does.
   *
   * The plan names this prefix in as many words (T1: "`EPISODE_SERIES` gains `grn` with a `GRN`
   * prefix in the existing format"), which is why it is here and not `G`.
   */
  grn: "GRN",
} as const;

export type EpisodeSeriesKey = keyof typeof EPISODE_SERIES;

export const EPISODE_SERIAL_DIGITS = 4;
export const EPISODE_MAX_SERIAL = 9_999; // per document type, per day

const SERVICE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one place that can mint an episode number, and therefore the one place that guards its
 * width — the `formatUhid` lesson: a 10,000th document in one day would otherwise pad to FIVE
 * digits and produce a number nothing downstream can parse, silently and forever.
 *
 * `serviceDate` is already the IST calendar date (`istDate(now)` at every call site), so the
 * YYMMDD slice is pure string work and no timezone arithmetic happens here. That is deliberate:
 * a date that has already been resolved to the hospital's day must not be re-derived from an
 * instant by a second piece of code that might disagree about the offset.
 */
export function formatEpisodeNo(key: EpisodeSeriesKey, serviceDate: string, n: number): string {
  if (!SERVICE_DATE_RE.test(serviceDate)) {
    throw new Error(`formatEpisodeNo: serviceDate must be an IST calendar date (YYYY-MM-DD), got "${serviceDate}"`);
  }
  if (!Number.isSafeInteger(n) || n < 1 || n > EPISODE_MAX_SERIAL) {
    throw new Error(
      `formatEpisodeNo: serial ${String(n)} is outside 1..${EPISODE_MAX_SERIAL} — ` +
        `${key} has issued more documents on ${serviceDate} than the ${EPISODE_SERIAL_DIGITS}-digit daily counter can name`,
    );
  }
  const yymmdd = `${serviceDate.slice(2, 4)}${serviceDate.slice(5, 7)}${serviceDate.slice(8, 10)}`;
  return `${EPISODE_SERIES[key]}${yymmdd}${String(n).padStart(EPISODE_SERIAL_DIGITS, "0")}`;
}

/**
 * Allocates the next number for (key, serviceDate) on the caller's transaction.
 *
 * The single-winner `UPDATE ... RETURNING` is the shipped pattern from `nextDocNo` (billing) and
 * `allocateToken` (opd), transcribed rather than reinvented — including its one sharp edge: the
 * RETURNING value is the POST-increment counter, so the number just handed out is one less. The
 * `INSERT ... ON CONFLICT DO NOTHING` above it is the cold-start path, where every racer's insert
 * no-ops after the first and all of them then contend on the same row.
 */
export async function nextEpisodeNo(tx: Tx, key: EpisodeSeriesKey, serviceDate: string): Promise<string> {
  if (!SERVICE_DATE_RE.test(serviceDate)) {
    throw new Error(`nextEpisodeNo: serviceDate must be an IST calendar date (YYYY-MM-DD), got "${serviceDate}"`);
  }
  await tx.insert(episodeSeries).values({ seriesKey: key, serviceDate, nextNo: 1 }).onConflictDoNothing();
  const rows = await tx
    .update(episodeSeries)
    .set({ nextNo: sql`${episodeSeries.nextNo} + 1` })
    .where(and(eq(episodeSeries.seriesKey, key), eq(episodeSeries.serviceDate, serviceDate)))
    .returning({ nextNo: episodeSeries.nextNo });
  return formatEpisodeNo(key, serviceDate, rows[0]!.nextNo - 1);
}
