import { bigint, date, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * EPISODE NUMBER SERIES — the per-day counters behind the V/A/L/S/R/P grammar (owner ruling
 * 2026-08-25). One row per (document type, service date); `nextEpisodeNo` moves it.
 *
 * THE GRAMMAR: `<letter><YYMMDD><4-digit daily serial>` — `V2608250147`. Eleven characters, no
 * separators. It is deliberately NOT the UHID's design and deliberately NOT the invoice's:
 *   - A UHID names a PERSON and is typed into a search box constantly, so it spends nothing on
 *     self-description. An episode number names an EVENT and is mostly printed, scanned, and
 *     stuck to a specimen tube or a film jacket — so it can afford to carry its own date, and a
 *     lab bench reading `L2608250023` knows the day without a lookup.
 *   - An invoice number is `INV/2627/000123` because GST demands a consecutive per-fiscal-year
 *     serial of at most 16 characters. That is tax law, not usability, and it is why this table
 *     is SEPARATE from `document_series` rather than a third period type inside it: the two
 *     counters answer to different authorities, and someone "tidying up" a clinical counter must
 *     not be one typo away from resetting a statutory one.
 *
 * GAPLESSNESS IS NOT REQUIRED, unlike the GST series next door. A rolled-back visit may skip a
 * number, exactly as `uhid_seq` may — do not let anyone build an expensive gapless guarantee for
 * a clinical counter on the strength of the invoice series sitting beside it.
 *
 * `service_date` is the IST calendar date the episode BELONGS to, never the row's insert instant:
 * an appointment booked in October for a slot in November is numbered in November's series, so
 * the day's list reads 1..N in the order the desk will work it.
 */
export const episodeSeries = pgTable(
  "episode_series",
  {
    seriesKey: text("series_key").notNull(), // 'visit'|'appointment'|'lab_order'|'lab_specimen'|'radiology_order'|'pharmacy_dispense'
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    nextNo: bigint("next_no", { mode: "number" }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.seriesKey, t.serviceDate] })],
);
