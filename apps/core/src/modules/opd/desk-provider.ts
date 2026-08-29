import { and, count, eq, inArray } from "drizzle-orm";
import { opdEncounters } from "../../kernel/db/schema";
import { summaryByDoctor } from "./queue";
import { doctorForUser } from "./masters";
import { istHourMinute } from "./time";
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
    stats: [
      { key: "desk.opd.waiting", value: String(waiting) },
      { key: "desk.opd.withVitals", value: String(withVitals) },
      { key: "desk.opd.sessionsOpen", value: `${String(openSessions)} / ${String(summaries.length)}` },
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
    stats: [
      { key: "desk.opd.waiting", value: String(mine?.waitingCount ?? 0) },
      { key: "desk.opd.nowServing", value: mine?.nowServing === null || mine === undefined ? "—" : String(mine.nowServing) },
      { key: "desk.opd.seen", value: String(seen[0]?.n ?? 0) },
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
      { key: "desk.opd.opened", value: String(opened[0]?.n ?? 0) },
      { key: "desk.opd.stillHere", value: String(live[0]?.n ?? 0) },
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

  const summaries = await getPatientSummaries(ctx.db, ctx.actor, rows.map((r) => r.patientId));
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
};
