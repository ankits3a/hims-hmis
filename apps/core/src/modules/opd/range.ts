import { and, count, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { opdAppointments, opdEncounters } from "../../kernel/db/schema";
import { istDateTimeToUtc } from "./time";
import { addDays } from "../../kernel/desk/rollup";
import { dropEmptyBuckets } from "../../kernel/desk/range";
import type { RangeBucket, RangeCtx, RangeDimension, RangeKey } from "../../kernel/desk/range";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * PHASE STAFF-REPORTS T3 — OPD'S CONTRIBUTION TO A RANGE REPORT.
 *
 * The owner's question is *"which user registered / booked / billed, for which OPD department and
 * which doctor, and how many were new, revisiting or renewals"*. Everything but the money is here;
 * billing contributes its own buckets on keys it computes from its own tables (T5), and the two meet
 * in `mergeBuckets` rather than in a join. `range.ts` carries the argument for why.
 *
 * ═══ THE VISIT-TYPE SPLIT COMES FREE, BY GROUPING ON IT ALWAYS ═══
 *
 * The SQL groups by the caller's dimensions PLUS `visit_type`, always, whether or not the caller
 * asked for it. Each resulting row then emits both the total and its own bucket's measure, and the
 * merge folds them back together on the caller's key.
 *
 * So a report grouped by user gets `opd.visitsNew`, `opd.visitsRevisit` and `opd.visitsRenewal` as
 * COLUMNS; one grouped by user AND visit type gets them as ROWS as well, and the two agree because
 * they came from the same query. The alternative — one query for the total and three filtered ones
 * for the split — is the drift T1's `desk-provider.ts` already refused for the same reason: four
 * predicates that must stay identical, and nothing that notices when they stop.
 *
 * ═══ A MEASURE KEYS ONLY BY DIMENSIONS IT ACTUALLY CARRIES ═══
 *
 * An appointment has a doctor and a department; it has no visit type, because nobody has been seen
 * yet. So when a report is grouped by visit type, bookings land on the key whose `visitType` is
 * ABSENT rather than being forced into `new`. The kernel renders an absent dimension as an empty
 * cell, and empty means *"this measure is not dimensioned that way"* — not *"unknown"*. Inventing a
 * value would put a number under a heading that never applied to it, which is worse than a gap
 * because it sums.
 */

/** Which column answers each dimension, for the encounter query. */
function encounterColumn(d: RangeDimension): PgColumn | null {
  switch (d) {
    case "userId": return opdEncounters.openedBy;
    case "departmentId": return opdEncounters.departmentId;
    case "doctorId": return opdEncounters.doctorId;
    case "visitType": return opdEncounters.visitType;
    case "day": return opdEncounters.serviceDate;
    /*
     * T5 ADDED THESE AND THE COMPILER DEMANDED AN ANSWER — which is the seam working. A new
     * dimension cannot be introduced without every provider saying whether it carries it, so there
     * is no way to add one and have half the modules silently key by nothing.
     *
     * A visit has no payer and no service head: `intended_payer` lives on the INVOICE, and a
     * service category is a billed line. Those are billing's to key, and the two modules' buckets
     * meet in `mergeBuckets` on the dimensions they share.
     */
    case "payer": return null;
    case "serviceCategory": return null;
  }
}

/**
 * And for the booking query. A booking's DAY is the day the clerk booked it — `booked_at` — not the
 * day of the appointment, because this report attributes an ACT to the person who performed it, and
 * `opd.appointmentsBooked` (the fact this must reconcile against) counts the same way.
 *
 * `at time zone 'Asia/Kolkata'` is the house idiom for an IST calendar day in SQL —
 * `modules/pharmacy/queue.ts` and `modules/ot/bill.ts` both already use it. It is deliberately NOT
 * a hand-rolled `330 * 60_000`: `ist-clock-parity.test.ts` maintains a census of the sites that
 * write the offset by hand and reddens on a new one, and a named zone is the mechanism that census
 * exists to push people towards.
 */
const BOOKED_IST_DAY = sql<string>`(${opdAppointments.bookedAt} at time zone 'Asia/Kolkata')::date`;

function appointmentColumn(d: RangeDimension): PgColumn | SQL<string> | null {
  switch (d) {
    case "userId": return opdAppointments.bookedBy;
    case "departmentId": return opdAppointments.departmentId;
    case "doctorId": return opdAppointments.doctorId;
    case "visitType": return null; // a booking has no visit type — see this file's header
    case "day": return BOOKED_IST_DAY;
    case "payer": return null;         // money dimensions, both — see `encounterColumn`
    case "serviceCategory": return null;
  }
}

export async function opdRange(ctx: RangeCtx): Promise<RangeBucket[]> {
  const { filters, groupBy } = ctx;
  /*
   * `dropEmptyBuckets` is load-bearing, not hygiene: an aggregate with no GROUP BY returns one row
   * with a count of 0 rather than no rows, so a quiet day would otherwise assert
   * `opd.appointmentsBooked: 0` on a grouping where bookings carry no dimension at all. Its doc
   * carries the argument.
   */
  return dropEmptyBuckets([...await encounterBuckets(ctx), ...await bookingBuckets(ctx)]);

  async function encounterBuckets({ db }: RangeCtx): Promise<RangeBucket[]> {
    /*
     * ALWAYS GROUPED BY VISIT TYPE, whether or not the caller asked — see the header. The extra
     * grouping costs at most three rows per key and buys the split for free.
     */
    const dims = [...new Set<RangeDimension>([...groupBy, "visitType"])];
    const cols = dims.map((d) => ({ d, col: encounterColumn(d)! }));

    const where = and(
      gte(opdEncounters.serviceDate, filters.from),
      lte(opdEncounters.serviceDate, filters.to),
      ...(filters.userIds !== undefined ? [inArray(opdEncounters.openedBy, filters.userIds)] : []),
      ...(filters.departmentId !== undefined ? [eq(opdEncounters.departmentId, filters.departmentId)] : []),
      ...(filters.doctorId !== undefined ? [eq(opdEncounters.doctorId, filters.doctorId)] : []),
      ...(filters.visitType !== undefined ? [eq(opdEncounters.visitType, filters.visitType)] : []),
    );

    const rows = await db
      .select({
        ...Object.fromEntries(cols.map(({ d, col }) => [d, col])),
        n: count(),
      } as Record<string, unknown> as { n: SQL<number> })
      .from(opdEncounters)
      .where(where)
      .groupBy(...cols.map((c) => c.col));

    return (rows as unknown as (Record<string, string | null> & { n: number })[]).map((row) => {
      const key = keyFrom(row, dims);
      const split = MEASURE_BY_VISIT_TYPE[row["visitType"] ?? ""];
      return {
        key: groupBy.includes("visitType") ? key : dropVisitType(key),
        measures: {
          "opd.visitsOpened": row.n,
          ...(split === undefined ? {} : { [split]: row.n }),
        },
      };
    });
  }

  async function bookingBuckets({ db }: RangeCtx): Promise<RangeBucket[]> {
    /*
     * A BOOKING HAS NO VISIT TYPE. When the caller filters BY visit type they are asking about
     * consultations, and a booking cannot satisfy that filter — returning bookings anyway would
     * add a number that does not answer the question asked.
     */
    if (filters.visitType !== undefined) return [];

    const dims = groupBy.filter((d) => appointmentColumn(d) !== null);
    const cols = dims.map((d) => ({ d, col: appointmentColumn(d)! }));

    // The IST range as UTC instants, from the module's own clock helper rather than a second copy.
    const from = istDateTimeToUtc(filters.from, "00:00");
    const to = istDateTimeToUtc(addDays(filters.to, 1), "00:00");

    const where = and(
      gte(opdAppointments.bookedAt, from),
      lt(opdAppointments.bookedAt, to),
      ...(filters.userIds !== undefined ? [inArray(opdAppointments.bookedBy, filters.userIds)] : []),
      ...(filters.departmentId !== undefined ? [eq(opdAppointments.departmentId, filters.departmentId)] : []),
      ...(filters.doctorId !== undefined ? [eq(opdAppointments.doctorId, filters.doctorId)] : []),
    );

    const rows = await db
      .select({
        ...Object.fromEntries(cols.map(({ d, col }) => [d, col])),
        n: count(),
      } as Record<string, unknown> as { n: SQL<number> })
      .from(opdAppointments)
      .where(where)
      .groupBy(...cols.map((c) => c.col));

    return (rows as unknown as (Record<string, string | null> & { n: number })[]).map((row) => ({
      key: keyFrom(row, dims),
      measures: { "opd.appointmentsBooked": row.n },
    }));
  }
}

const MEASURE_BY_VISIT_TYPE: Record<string, string | undefined> = {
  new: "opd.visitsNew",
  revisit: "opd.visitsRevisit",
  renewal: "opd.visitsRenewal",
};

/** A NULL column is an ABSENT dimension, never the string "null" — see the header. */
function keyFrom(row: Record<string, string | null>, dims: readonly RangeDimension[]): RangeKey {
  const key: RangeKey = {};
  for (const d of dims) {
    const value = row[d];
    if (value !== null && value !== undefined) key[d] = String(value);
  }
  return key;
}

/**
 * The key with `visitType` removed — used when the SQL grouped by it (always, so the split comes
 * free) but the caller did not ask for it as a column. Written as a delete on a copy rather than a
 * destructured discard, because the discard needs a binding the linter then calls unused.
 */
function dropVisitType(key: RangeKey): RangeKey {
  const rest = { ...key };
  delete rest.visitType;
  return rest;
}
