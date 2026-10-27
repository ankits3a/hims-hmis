import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { ewsBandRank } from "@hmis/contracts";
import { ipdAdmissions, ipdNursingAlerts, ipdNursingAssessments, ipdShiftHandovers } from "../../kernel/db/schema";
import { IPD_NURSING_STATES, lastSetAt, latestScores } from "./nursing";
import { nextDueOf } from "./nursing-read";
import { nowIdentities, nowSubtitle, rankNowRows } from "./now-cards";
import type { IpdEwsBand, IpdEwsKind } from "@hmis/contracts";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";
import type { NowRow } from "./now-cards";

/**
 * E4.1 (#733) — the four NURSING Now cards (spec §0B "Now cards"; MAP.md "OWED TO M4"). One provider and one permission
 * per card (`manifest.ts` `desk`), each the permission of the act that answers it:
 *
 *   ipd.overdue_vitals    `ipd.vitals.record`      a set past its due time (by the last band; first set 1 h after admission)
 *   ipd.assessment_due    `ipd.assessment.record`  no admission assessment yet: due within the hour (warn) or overdue (hot)
 *   ipd.ews_rising        `ipd.ews.respond`        an open early-warning alert (hot while unacknowledged or emergency), or a
 *                                                  score up 2+ since the set before
 *   ipd.handover_pending  `ipd.handover.shift`     a shift handover given and not yet accepted (not one the reader gave);
 *                                                  hot after 30 minutes
 *
 * A stable patient makes no row and an empty card is not sent. Rows use the shared identity rule (`nowIdentities`): a
 * sealed patient shows no UHID and no bed. No money (decision 0058). Hospital-wide, top five by the shared ranking
 * (they stay hospital-wide; WM-1's shift map narrows my shift and the station, not these cards).
 */

const minutesSince = (from: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
const KIND_WORD: Record<IpdEwsKind, string> = { news2: "NEWS2", meows: "MEOWS", pews: "PEWS" };
const BAND_WORD: Record<IpdEwsBand, string> = { low: "low", low_medium: "single red", medium: "urgent", high: "emergency" };
/** DECIDED: a shift handover unaccepted this long is hot (the next shift has started). */
export const IPD_HANDOVER_HOT_MINUTES = 30;

async function onWard(ctx: DeskProviderCtx) {
  return ctx.db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.state, [...IPD_NURSING_STATES]));
}

export async function overdueVitalsCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const admissions = (await onWard(ctx)).filter((a) => a.admittedAt !== null);
  if (admissions.length === 0) return [];
  const ids = admissions.map((a) => a.id);
  const assessed = new Set((await db.select({ id: ipdNursingAssessments.admissionId }).from(ipdNursingAssessments)
    .where(inArray(ipdNursingAssessments.admissionId, ids))).map((r) => r.id));
  const [scores, last] = await Promise.all([latestScores(db, ids), lastSetAt(db, ids)]);
  const late = admissions.flatMap((a) => {
    // Before the assessment the assessment is what is due (its own card); vitals ride with it.
    if (!assessed.has(a.id)) return [];
    const due = nextDueOf({ admittedAt: a.admittedAt, assessed: true, lastSet: last.get(a.id) ?? null, last: scores.get(a.id)?.[0] }, now);
    return due !== null && due.overdue ? [{ a, due }] : [];
  });
  if (late.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, late.map((x) => x.a));
  const rows: NowRow[] = late.map(({ a, due }) => {
    const wait = minutesSince(due.dueAt, now);
    const id = who.get(a.id)!;
    const band = scores.get(a.id)?.[0]?.scoreBand;
    return {
      id: a.id, badge: "!", title: id.name, subtitle: nowSubtitle(id, `vitals ${String(wait)} min late`),
      action: "Record", href: "/ipd/my-shift", severity: wait >= 60 || (band !== undefined && ewsBandRank(band) >= 2) ? "hot" : "warn", waitMinutes: wait,
    };
  });
  return [{ key: "ipd.overdue_vitals", band: "now", titleKey: "desk.ipdOverdueVitals.title", rows: rankNowRows(rows).slice(0, 5) }];
}

export async function assessmentDueCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const admissions = (await onWard(ctx)).filter((a) => a.admittedAt !== null);
  if (admissions.length === 0) return [];
  const assessed = new Set((await db.select({ id: ipdNursingAssessments.admissionId }).from(ipdNursingAssessments)
    .where(inArray(ipdNursingAssessments.admissionId, admissions.map((a) => a.id)))).map((r) => r.id));
  const due = admissions.filter((a) => !assessed.has(a.id));
  if (due.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, due);
  const rows: NowRow[] = due.map((a) => {
    const since = minutesSince(a.admittedAt!, now);
    const id = who.get(a.id)!;
    const words = since >= 60 ? `assessment ${String(since - 60)} min late` : `assessment due in ${String(60 - since)} min`;
    return {
      id: a.id, badge: "!", title: id.name, subtitle: nowSubtitle(id, words), action: "Assess",
      href: `/ipd/ward?admission=${a.id}`, severity: since >= 60 ? "hot" : "warn", waitMinutes: since,
    };
  });
  return [{ key: "ipd.assessment_due", band: "now", titleKey: "desk.ipdAssessmentDue.title", rows: rankNowRows(rows).slice(0, 5) }];
}

export async function ewsRisingCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const admissions = await onWard(ctx);
  if (admissions.length === 0) return [];
  const ids = admissions.map((a) => a.id);
  const open = new Map((await db.select().from(ipdNursingAlerts).where(and(
    inArray(ipdNursingAlerts.admissionId, ids), eq(ipdNursingAlerts.kind, "ews"), isNull(ipdNursingAlerts.clearedAt),
  ))).map((r) => [r.admissionId, r] as const));
  const scores = await latestScores(db, ids);
  const hits = admissions.flatMap((a) => {
    const alert = open.get(a.id);
    const [cur, prev] = scores.get(a.id) ?? [];
    const rising = cur !== undefined && prev !== undefined && cur.scoreValue - prev.scoreValue >= 2;
    return alert !== undefined || rising ? [{ a, alert, cur, prev }] : [];
  });
  if (hits.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, hits.map((h) => h.a));
  const rows: NowRow[] = hits.map(({ a, alert, cur, prev }) => {
    const id = who.get(a.id)!;
    const score = cur === undefined ? "" : `${KIND_WORD[cur.scoreKind]} ${String(cur.scoreValue)}${prev === undefined ? "" : ` (was ${String(prev.scoreValue)})`}`;
    const since = alert === undefined ? (cur === undefined ? 0 : minutesSince(cur.observedAt, now)) : minutesSince(alert.escalatedAt ?? alert.raisedAt, now);
    const state = alert === undefined ? "rising" : alert.acknowledgedAt === null ? `${BAND_WORD[alert.band as IpdEwsBand]} · not acknowledged` : `${BAND_WORD[alert.band as IpdEwsBand]} · acknowledged`;
    const hot = alert !== undefined && (alert.acknowledgedAt === null || alert.band === "high");
    return {
      id: a.id, badge: "!", title: id.name, subtitle: nowSubtitle(id, [score, state].filter((s) => s !== "").join(" · ")),
      action: "Open", href: `/ipd/ward?admission=${a.id}`, severity: hot ? "hot" : "warn", waitMinutes: since,
    };
  });
  return [{ key: "ipd.ews_rising", band: "now", titleKey: "desk.ipdEwsRising.title", rows: rankNowRows(rows).slice(0, 5) }];
}

export async function handoverPendingCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const rows0 = await db.select().from(ipdShiftHandovers).where(and(
    eq(ipdShiftHandovers.status, "given"), ne(ipdShiftHandovers.givenBy, ctx.reader.id),
    gte(ipdShiftHandovers.givenAt, new Date(now.getTime() - 24 * 3_600_000)),
  ));
  if (rows0.length === 0) return [];
  const admissions = await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, rows0.map((r) => r.admissionId)));
  const live = new Map(admissions.filter((a) => (IPD_NURSING_STATES as readonly string[]).includes(a.state)).map((a) => [a.id, a] as const));
  const pending = rows0.filter((r) => live.has(r.admissionId));
  if (pending.length === 0) return [];
  const who = await nowIdentities(db, ctx.reader, pending.map((r) => live.get(r.admissionId)!));
  const rows: NowRow[] = pending.map((r) => {
    const id = who.get(r.admissionId)!;
    const wait = minutesSince(r.givenAt, now);
    return {
      id: r.id, badge: "!", title: id.name, subtitle: nowSubtitle(id, `handover waiting ${String(wait)} min`), action: "Accept",
      href: "/ipd/handovers", severity: wait >= IPD_HANDOVER_HOT_MINUTES ? "hot" : "warn", waitMinutes: wait,
    };
  });
  return [{ key: "ipd.handover_pending", band: "now", titleKey: "desk.ipdHandoverPending.title", rows: rankNowRows(rows).slice(0, 5) }];
}
