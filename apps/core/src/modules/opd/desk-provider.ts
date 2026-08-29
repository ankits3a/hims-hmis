import { and, count, eq, gte, inArray, lt } from "drizzle-orm";
import {
  opdAppointments, opdEncounters, opdPrescriptions, opdVitals, patients,
} from "../../kernel/db/schema";

import { summaryByDoctor } from "./queue";
import { doctorForUser } from "./masters";
import { istDateTimeToUtc, istHourMinute } from "./time";
import { getPatientSummaries } from "../patients";
import type { DeskCard, DeskProvider, DeskProviderCtx, ReportSection } from "../../kernel/desk/types";

/**
 * PLAN 07c T1 — OPD's cards.
 *
 * TWO CARDS, AND WHICH ONE YOU GET IS A FACT ABOUT THE HOSPITAL RATHER THAN A SETTING. A doctor is
 * a row in `opd_doctors`; if the signed-in user is one, their own queue is the thing they came to
 * this screen for and the hall is background. If they are not, the hall IS the work.
 *
 * NO PATIENT IDENTITY APPEARS ON EITHER CARD. Both are counts. That is not an oversight to fix
 * later: the desk is chrome, visible over a shoulder from across a counter, and a queue of names on
 * a home screen is the surface `opd-display.tsx` was deliberately built WITHOUT (§11.5 — the board
 * announces tokens, never names). Rows that name a patient belong on a screen somebody opened on
 * purpose.
 */
const LIVE = ["registered", "waiting", "in_consultation"] as const;

async function hallCard(ctx: DeskProviderCtx): Promise<DeskCard> {
  const summaries = await summaryByDoctor(ctx.db, undefined, ctx.date);
  const waiting = summaries.reduce((n, s) => n + s.waitingCount, 0);
  const withVitals = summaries.reduce((n, s) => n + s.waitingVitalsCount, 0);
  const openSessions = summaries.filter((s) => s.status === "in").length;
  return {
    key: "opd.hall",
    band: "now",
    titleKey: "desk.opd.hall",
    /**
     * PLAN 07c T4 / DD11 — the hall is live, and every doctor's queue is a topic it changes on.
     * One subscription per scheduled doctor is the honest set: `opdTopicsFor` routes every queue
     * and visit event to `queue:<doctorId>:<serviceDate>` and there is no whole-hall topic to
     * lean on. All of them sit in the `queue` space, which is gated on `opd.queue.read` — this
     * provider's own permission, so a caller holding this card can always subscribe to them.
     */
    topics: summaries.map((s) => `queue:${s.doctor.id}:${ctx.date}`),
    stats: [
      { key: "desk.opd.waiting", value: String(waiting), href: "/opd/desk" },
      { key: "desk.opd.withVitals", value: String(withVitals), href: "/opd/vitals" },
      { key: "desk.opd.sessionsOpen", value: `${String(openSessions)} / ${String(summaries.length)}`, href: "/opd/desk" },
    ],
    /**
     * A DOCTOR WHO HAS NOT OPENED THEIR SESSION IS THE ONE THING THIS CARD NAMES, and it names a
     * DOCTOR rather than a patient. It is the "silent lateness" signal the front-office brainstorm
     * called the most valuable absence in the hall: a session that never opened produces no waiting
     * alert, because nobody is waiting on a queue that does not exist yet.
     */
    rows: summaries
      .filter((s) => s.scheduledToday && s.status !== "in")
      .map((s) => ({
        id: s.doctor.id,
        badge: "!",
        title: s.doctor.displayName,
        subtitle: "desk.opd.notStarted",
        severity: "warn" as const,
        href: "/opd/desk",
      })),
  };
}

async function myQueueCard(ctx: DeskProviderCtx, doctorId: string): Promise<DeskCard> {
  const summaries = await summaryByDoctor(ctx.db, undefined, ctx.date);
  const mine = summaries.find((s) => s.doctor.id === doctorId);
  const seen = await ctx.db
    .select({ n: count() })
    .from(opdEncounters)
    .where(and(
      eq(opdEncounters.doctorId, doctorId),
      eq(opdEncounters.serviceDate, ctx.date),
      eq(opdEncounters.status, "completed"),
    ));
  return {
    key: "opd.myQueue",
    band: "now",
    titleKey: "desk.opd.myQueue",
    topics: [`queue:${doctorId}:${ctx.date}`],
    stats: [
      { key: "desk.opd.waiting", value: String(mine?.waitingCount ?? 0), href: "/opd/consult" },
      { key: "desk.opd.nowServing", value: mine?.nowServing === null || mine === undefined ? "—" : String(mine.nowServing), href: "/opd/consult" },
      { key: "desk.opd.seen", value: String(seen[0]?.n ?? 0), href: "/my-day" },
    ],
  };
}

/** Visits this person OPENED today — `opened_by` is stamped on the encounter, so this is exact. */
async function myVisitsCard(ctx: DeskProviderCtx): Promise<DeskCard> {
  const opened = await ctx.db
    .select({ n: count() })
    .from(opdEncounters)
    .where(and(eq(opdEncounters.openedBy, ctx.actor.id), eq(opdEncounters.serviceDate, ctx.date)));
  const live = await ctx.db
    .select({ n: count() })
    .from(opdEncounters)
    .where(and(
      eq(opdEncounters.openedBy, ctx.actor.id),
      eq(opdEncounters.serviceDate, ctx.date),
      inArray(opdEncounters.status, [...LIVE]),
    ));
  return {
    key: "opd.myVisits",
    band: "today",
    titleKey: "desk.opd.myVisits",
    stats: [
      /**
       * PLAN 07c T4 — BOTH FIGURES DRILL, AND THEY DRILL TO DIFFERENT PLACES. "Opened" is the
       * person's own day and its rows are the report this provider already composes (T2), so it
       * goes to `/my-day`. "Still here" is work in the hall right now, and its rows are the
       * queue board. Sending both to the same screen would make one of the two a lie.
       */
      { key: "desk.opd.opened", value: String(opened[0]?.n ?? 0), href: "/my-day" },
      { key: "desk.opd.stillHere", value: String(live[0]?.n ?? 0), href: "/opd/desk" },
    ],
  };
}

/**
 * PLAN 07c T2/T3 — the visits this person opened today, as ROWS rather than a count.
 *
 * ═══ THE PATIENT NAMES GO THROUGH `getPatientSummaries`, AND MEASUREMENT CORRECTED WHAT THAT BUYS ═══
 *
 * A card shows a number and leaks nothing. A REPORT lists people, and this one becomes a CSV that
 * leaves the building, so a confidential patient must appear under their ALIAS.
 *
 * **The seal is enforced UPSTREAM, not by the line below, and the mutant proved it.** Replacing
 * `restricted ? alias : name` with a bare `name` was expected to leak the real name into the file;
 * what it actually produced was `—`, because `getPatientSummaries` already returns `name: null` for
 * a restricted row and hands back the alias separately. So the protection is the summary reader's,
 * and the line below is about DISPLAY: alias, or a dash where a person should be.
 *
 * That distinction is worth keeping rather than tidying away. A provider that reads patients through
 * anything OTHER than `getPatientSummaries` — a raw join for speed, say — inherits none of it, and
 * would leak exactly what this comment used to claim credit for preventing.
 */
async function myVisitsSection(ctx: DeskProviderCtx): Promise<ReportSection> {
  const rows = await ctx.db
    .select({
      visitNo: opdEncounters.visitNo,
      patientId: opdEncounters.patientId,
      visitType: opdEncounters.visitType,
      status: opdEncounters.status,
      openedAt: opdEncounters.openedAt,
    })
    .from(opdEncounters)
    .where(and(eq(opdEncounters.openedBy, ctx.actor.id), eq(opdEncounters.serviceDate, ctx.date)))
    .orderBy(opdEncounters.openedAt);

  /*
   * PLAN 07c T9 / DD14 — `ctx.reader`, NOT `ctx.actor`. The ROWS are the subject's (filtered on
   * `opened_by` above); the VISIBILITY is the looker's. For every self-scoped call these are the
   * same person, and for a supervisor's drill they are not — see `DeskProviderCtx.reader` for the
   * leak that collapsing them into one field would create.
   */
  const summaries = await getPatientSummaries(ctx.db, ctx.reader, rows.map((r) => r.patientId));
  const byId = new Map(summaries.map((s) => [s.requestedId, s]));

  return {
    key: "opd.myVisits",
    titleKey: "report.opd.myVisits",
    columnKeys: ["report.col.time", "report.col.visitNo", "report.col.uhid", "report.col.patient", "report.col.type", "report.col.status"],
    rows: rows.map((r) => {
      const p = byId.get(r.patientId);
      return [
        istHourMinute(r.openedAt),
        r.visitNo,
        p?.uhid ?? "—",
        // restricted → the alias, never the name. This is the field that leaves the building.
        (p?.restricted === true ? p.alias : p?.name) ?? "—",
        r.visitType,
        r.status,
      ];
    }),
    totals: ["", "", "", "", "", String(rows.length)],
  };
}

/**
 * PLAN 07c T8 — OPD's counters for one person on one day.
 *
 * ═══ EACH ONE IS CUT ON THE GRAIN THE ACT ACTUALLY HAPPENED ON, AND THEY DIFFER ═══
 *
 * A visit is stamped with `service_date`, an IST calendar day the hospital already agreed on, so
 * "visits I opened on the 17th" is an equality. Vitals, prescriptions and bookings carry only an
 * INSTANT (`recorded_at`, `issued_at`, `booked_at`), so their day is an IST window over that
 * instant. Mixing the two — filtering a timestamp column against a date string — is the defect that
 * silently drops the 18:30-to-midnight slice of every day, and it is invisible because the number
 * is merely small rather than absent.
 *
 * **A BOOKING IS COUNTED ON THE DAY IT WAS MADE, NOT THE DAY IT IS FOR.** `opd_appointments` has
 * both, and `service_date` is the SLOT's date. A clerk who books forty appointments for next month
 * did forty things today; crediting them to next month would empty today's brief and then flood a
 * day the clerk may not even work.
 */
async function opdFacts(ctx: DeskProviderCtx): Promise<Record<string, number>> {
  /*
   * The IST window of the day, built from `istDateTimeToUtc` rather than from a fresh offset
   * expression. `ist-clock-parity.test.ts` pins the census of files that write the hospital's clock
   * by hand and reddens on a new one (ledger §2.105) — an eleventh copy has to be argued for in
   * writing, and this one has no argument: the helper already exists two files away.
   */
  const from = istDateTimeToUtc(ctx.date, "00:00");
  const to = new Date(from.getTime() + 86_400_000);
  const one = async (rows: Promise<{ n: number }[]>): Promise<number> => (await rows)[0]?.n ?? 0;

  const [opened, registered, vitals, consults, bookings, prescriptions] = await Promise.all([
    one(ctx.db.select({ n: count() }).from(opdEncounters)
      .where(and(eq(opdEncounters.openedBy, ctx.actor.id), eq(opdEncounters.serviceDate, ctx.date)))),
    one(ctx.db.select({ n: count() }).from(patients)
      .where(and(eq(patients.createdBy, ctx.actor.id), gte(patients.createdAt, from), lt(patients.createdAt, to)))),
    one(ctx.db.select({ n: count() }).from(opdVitals)
      .where(and(eq(opdVitals.recordedBy, ctx.actor.id), gte(opdVitals.recordedAt, from), lt(opdVitals.recordedAt, to)))),
    /*
     * A CONSULT IS COUNTED WHEN IT COMPLETED, and against the DOCTOR the encounter is assigned to
     * rather than against `opened_by` — the clerk who opened the visit did not do the consultation.
     * `doctorForUser` is what maps the signed-in person to that row; somebody who is not a doctor
     * has none and correctly scores zero rather than being credited with the clerk's visits.
     */
    (async () => {
      const doctor = await doctorForUser(ctx.db, ctx.actor.id);
      if (doctor === null) return 0;
      return one(ctx.db.select({ n: count() }).from(opdEncounters).where(and(
        eq(opdEncounters.doctorId, doctor.id), eq(opdEncounters.serviceDate, ctx.date),
        eq(opdEncounters.status, "completed"),
      )));
    })(),
    one(ctx.db.select({ n: count() }).from(opdAppointments)
      .where(and(eq(opdAppointments.bookedBy, ctx.actor.id), gte(opdAppointments.bookedAt, from), lt(opdAppointments.bookedAt, to)))),
    one(ctx.db.select({ n: count() }).from(opdPrescriptions)
      .where(and(eq(opdPrescriptions.issuedBy, ctx.actor.id), gte(opdPrescriptions.issuedAt, from), lt(opdPrescriptions.issuedAt, to)))),
  ]);

  return {
    "opd.visitsOpened": opened,
    "opd.patientsRegistered": registered,
    "opd.vitalsRecorded": vitals,
    "opd.consultsCompleted": consults,
    "opd.appointmentsBooked": bookings,
    "opd.prescriptionsIssued": prescriptions,
  };
}

export const opdDeskProvider: DeskProvider = {
  key: "opd.desk",
  permission: "opd.queue.read",
  async load(ctx) {
    const doctor = await doctorForUser(ctx.db, ctx.actor.id);
    const cards = doctor ? [await myQueueCard(ctx, doctor.id)] : [await hallCard(ctx)];
    cards.push(await myVisitsCard(ctx));
    return cards;
  },
  report: async (ctx) => [await myVisitsSection(ctx)],
  facts: opdFacts,
};
