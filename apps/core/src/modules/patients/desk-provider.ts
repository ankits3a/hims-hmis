import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { events, patientMergeRequests, patients } from "../../kernel/db/schema";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import type { DeskCard, DeskProvider, DeskProviderCtx } from "../../kernel/desk/types";
import type { Db } from "../../kernel/db/client";

/**
 * FD-1 T1 — THE REGISTRATION TILE, AND "WHAT CAME BACK".
 *
 * The clerk's home (`GET /me/desk`) renders whatever the providers return (07c DD1); the
 * `patients` module had none, so a registration clerk's own count of the day lived in the OPD
 * provider's facts and nowhere on her desk. Two cards, both COUNTS WITH DOORS, no patient named
 * (07c's hall-card rule: a home screen is chrome, visible over a shoulder):
 *
 *   `patients.registration` (today) — registered by me · without a mobile · duplicates pending
 *   `patients.cameBack` (the last thirty days) — the half of the job nobody measures and the only
 *   half you can act on (Dashboard artboard): duplicates confirmed · without a mobile · amended
 *   within a week of registration.
 *
 * ═══ THE GRAIN ═══
 *
 * `patients.created_at` is an INSTANT, so "today" is the IST window over it (`istDayWindow` — the
 * one site that does the offset properly, per `ist-clock-parity.test.ts`); a duplicate is a merge
 * request whose LOSER I registered, counted when it was EXECUTED (a request is a suspicion, an
 * execution is a fact); an amendment is a `patient.updated` event on a patient I registered,
 * inside seven days of that registration — the "spelling off an ID at the second visit" the
 * artboard names. Reading the event log rather than `updated_at` keeps a photo or a QR reissue
 * (which touch `updated_at`) out of the count.
 *
 * ═══ NO KERNEL EDIT (phase doc D3) ═══
 *
 * "What came back" is a CARD, not a brief clause: a clause means editing `kernel/desk/brief.ts`,
 * a file that belongs to everyone. The figures screen renders these stats as the artboard's
 * three sentences.
 */
const WEEK_MS = 7 * 86_400_000;
const LOOKBACK_DAYS = 30;

function windowFor(date: string, days: number): { from: Date; to: Date } {
  const day = istDayWindow(new Date(`${date}T00:00:00+05:30`));
  return { from: new Date(day.start.getTime() - (days - 1) * 86_400_000), to: day.end };
}

async function one(rows: Promise<{ n: number }[]>): Promise<number> {
  return (await rows)[0]?.n ?? 0;
}

async function registeredBy(db: Db, userId: string, w: { from: Date; to: Date }, noMobile = false): Promise<number> {
  return one(db.select({ n: count() }).from(patients).where(and(
    eq(patients.createdBy, userId), gte(patients.createdAt, w.from), lt(patients.createdAt, w.to),
    ...(noMobile ? [isNull(patients.phone)] : []),
  )));
}

/** Merge requests whose LOSER this person registered, by status, counted on the act's own instant. */
async function duplicatesOf(db: Db, userId: string, status: "requested" | "executed", w: { from: Date; to: Date }): Promise<number> {
  const at = status === "executed" ? patientMergeRequests.executedAt : patientMergeRequests.requestedAt;
  return one(db.select({ n: count() })
    .from(patientMergeRequests)
    .innerJoin(patients, eq(patientMergeRequests.loserId, patients.id))
    .where(and(eq(patients.createdBy, userId), eq(patientMergeRequests.status, status), gte(at, w.from), lt(at, w.to))));
}

/** `patient.updated` inside seven days of a registration this person made, registrations in the window. */
async function amendedWithinWeek(db: Db, userId: string, w: { from: Date; to: Date }): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(distinct ${events.patientId})` })
    .from(events)
    .innerJoin(patients, eq(events.patientId, patients.id))
    .where(and(
      eq(events.name, "patient.updated"),
      eq(patients.createdBy, userId),
      gte(patients.createdAt, w.from), lt(patients.createdAt, w.to),
      lt(events.occurredAt, sql`${patients.createdAt} + interval '7 days'`),
    ));
  return Number(rows[0]?.n ?? 0);
}

async function registrationCard(ctx: DeskProviderCtx): Promise<DeskCard> {
  const today = windowFor(ctx.date, 1);
  const [registered, noMobile, pending] = await Promise.all([
    registeredBy(ctx.db, ctx.actor.id, today),
    registeredBy(ctx.db, ctx.actor.id, today, true),
    duplicatesOf(ctx.db, ctx.actor.id, "requested", today),
  ]);
  return {
    key: "patients.registration",
    band: "today",
    titleKey: "desk.patients.registration",
    stats: [
      { key: "desk.patients.registered", value: String(registered), href: "/registration" },
      { key: "desk.patients.noMobile", value: String(noMobile), href: "/registration" },
      { key: "desk.patients.duplicatesPending", value: String(pending), href: "/merge" },
    ],
  };
}

async function cameBackCard(ctx: DeskProviderCtx): Promise<DeskCard> {
  const month = windowFor(ctx.date, LOOKBACK_DAYS);
  const [duplicates, noMobile, amended] = await Promise.all([
    duplicatesOf(ctx.db, ctx.actor.id, "executed", month),
    registeredBy(ctx.db, ctx.actor.id, month, true),
    amendedWithinWeek(ctx.db, ctx.actor.id, month),
  ]);
  return {
    key: "patients.cameBack",
    band: "today",
    titleKey: "desk.patients.cameBack",
    stats: [
      { key: "desk.patients.duplicatesConfirmed", value: String(duplicates), href: "/merge" },
      { key: "desk.patients.noMobileMonth", value: String(noMobile), href: "/registration" },
      { key: "desk.patients.amendedWeek", value: String(amended), href: "/registration" },
    ],
  };
}

export const patientsDeskProvider: DeskProvider = {
  key: "patients.desk",
  permission: "patients.register",
  load: async (ctx) => [await registrationCard(ctx), await cameBackCard(ctx)],
  facts: async (ctx) => {
    const today = windowFor(ctx.date, 1);
    const [noMobile, duplicates] = await Promise.all([
      registeredBy(ctx.db, ctx.actor.id, today, true),
      duplicatesOf(ctx.db, ctx.actor.id, "executed", today),
    ]);
    return { "patients.noMobile": noMobile, "patients.duplicates": duplicates };
  },
};
export { WEEK_MS as PATIENTS_AMEND_WINDOW_MS };
