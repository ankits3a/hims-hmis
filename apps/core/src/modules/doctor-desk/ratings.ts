import { and, count, countDistinct, desc, eq, gte, lte, ne } from "drizzle-orm";
import {
  RATING_MIN_OWN, RATING_MIN_POOL_PEOPLE, RATING_MIN_POOL_RATINGS, RATING_REASON_MAX, WORK_RATINGS, goodShare, newId,
} from "@hmis/contracts";
import type { Actor, WireMyRatings, WireRateItem, WorkRating } from "@hmis/contracts";
import { doctorDeskRatings } from "../../kernel/db/schema";
import { completedVisitById, completedVisitsOf } from "../opd";
import { getPatientSummaries } from "../patients";
import { addIstDays } from "../roster";
import { DoctorDeskError } from "./errors";
import { deskScope, patientOf, unitOfOn } from "./scope";
import type { DeskScope } from "./scope";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ DD-1.7 (D5) — A SENIOR'S WORD ON A RESIDENT'S WORK, for her PG logbook, never a league table ═══
 *
 * Owner board Professor.dc.html: *"How was Pooja's summary? Goes to her PG logbook, not to a league
 * table."* DECIDED (spec 8–9):
 *   · The work item in DD-1 is a unit resident's OPD visit finished today or yesterday (IST); the IPD
 *     discharge summary joins in DD-IPD.5. Good / Fine / Needs rework; Needs rework says why.
 *   · Who rates: a senior of the SAME unit — its head, its faculty, or a senior resident rating a JR or
 *     an intern. Never oneself (`self_rating`); once per item per rater (`already_rated`).
 *   · Who sees: the rated resident (her own figures and her own logbook) and the rater (what they gave).
 *     Nobody else reads a person's ratings.
 *   · The resident's page follows the owner's "my performance vs averages" rule (2026-10-09): her own
 *     share rated Good beside the department's and the hospital's — an anonymous average, never another
 *     person's name, rank or figure, worded neutrally, and only above a minimum sample.
 */
const RESIDENTS = new Set(["senior_resident", "junior_resident", "intern"]);
const JUNIORS = new Set(["junior_resident", "intern"]);

/** May `rater` rate `resident`'s work, by their roles in the unit? */
export function isSeniorOver(raterRole: string | undefined, residentRole: string | undefined): boolean {
  if (raterRole === undefined || residentRole === undefined || !RESIDENTS.has(residentRole)) return false;
  if (raterRole === "head" || raterRole === "faculty") return true;
  return raterRole === "senior_resident" && JUNIORS.has(residentRole);
}

const roleIn = (scope: DeskScope, userId: string): string | undefined => scope.members.find((m) => m.userId === userId)?.roleInTeam;

export async function rateWork(
  db: Db, actor: Actor, input: { workKind: "opd_visit"; workId: string; rating: WorkRating; reason: string | null }, at: Date,
): Promise<{ ratingId: string }> {
  if (!(WORK_RATINGS as readonly string[]).includes(input.rating)) throw new DoctorDeskError("unknown_work", "Unknown rating.");
  const reason = input.reason === null ? null : input.reason.trim().slice(0, RATING_REASON_MAX);
  if (input.rating === "needs_rework" && (reason === null || reason.length < 3)) {
    throw new DoctorDeskError("note_required", "Say in a few words what needs rework.");
  }
  const visit = await completedVisitById(db, input.workId);
  if (visit === null) throw new DoctorDeskError("unknown_work", "No finished visit by that id.");
  if (visit.userId === actor.id) throw new DoctorDeskError("self_rating", "Your own work is rated by your seniors.");
  const scope = await deskScope(db, actor, at);
  const today = scope.istDate;
  if (visit.serviceDate !== today && visit.serviceDate !== addIstDays(today, -1)) {
    throw new DoctorDeskError("unknown_work", "Only today's and yesterday's work is rated here.");
  }
  if (scope.unit === null) throw new DoctorDeskError("not_a_senior", "You are not in this resident's unit.");
  const theirs = await unitOfOn(db, visit.userId, visit.serviceDate);
  if (theirs?.teamId !== scope.unit.teamId || !isSeniorOver(roleIn(scope, actor.id), roleIn(scope, visit.userId))) {
    throw new DoctorDeskError("not_a_senior", "Only a senior of this resident's unit rates this work.");
  }
  const ratingId = newId();
  const won = await db.insert(doctorDeskRatings).values({
    id: ratingId, workKind: input.workKind, workId: visit.encounterId, workDate: visit.serviceDate,
    ratedUserId: visit.userId, raterId: actor.id, teamId: scope.unit.teamId, departmentId: scope.unit.departmentId,
    rating: input.rating, reason: reason === "" ? null : reason, createdAt: at,
  }).onConflictDoNothing().returning({ id: doctorDeskRatings.id });
  if (won.length === 0) throw new DoctorDeskError("already_rated", "You have already rated this work.");
  return { ratingId };
}

/** The finished work the asker may rate now: the unit residents they are senior over, today and yesterday. */
export async function rateItems(db: Db, actor: Actor, scope: DeskScope): Promise<WireRateItem[]> {
  if (scope.unit === null) return [];
  const myRole = roleIn(scope, actor.id);
  const residents = scope.members.filter((m) => m.userId !== actor.id && isSeniorOver(myRole, m.roleInTeam));
  if (residents.length === 0) return [];
  const visits = await completedVisitsOf(db, residents.map((r) => r.userId), [scope.istDate, addIstDays(scope.istDate, -1)]);
  if (visits.length === 0) return [];
  const mine = await db.select({ workId: doctorDeskRatings.workId, rating: doctorDeskRatings.rating }).from(doctorDeskRatings)
    .where(and(eq(doctorDeskRatings.raterId, actor.id), eq(doctorDeskRatings.workKind, "opd_visit")));
  const given = new Map(mine.map((m) => [m.workId, m.rating as WorkRating] as const));
  const summaries = new Map((await getPatientSummaries(db, actor, visits.map((v) => v.patientId))).map((s) => [s.requestedId, s] as const));
  return visits.map((v): WireRateItem => {
    const r = residents.find((x) => x.userId === v.userId)!;
    return {
      workKind: "opd_visit", workId: v.encounterId, visitNo: v.visitNo, workDate: v.serviceDate,
      patient: patientOf(summaries.get(v.patientId), v.patientId),
      resident: { userId: r.userId, name: r.name, role: r.roleInTeam },
      completedAt: v.completedAt?.toISOString() ?? null, mine: given.get(v.encounterId) ?? null,
    };
  });
}

const monthBounds = (istDate: string): { from: string; to: string; month: string } => {
  const month = istDate.slice(0, 7);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { month, from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
};

/**
 * An anonymous pool: everybody's ratings in the window EXCEPT the asker's own, so the average cannot be
 * worked back to one colleague by subtracting oneself (review F2). Settled days only — up to yesterday —
 * so the figure does not move under a rating given this morning.
 */
async function pool(db: Db, from: string, to: string, departmentId: string | null, exceptUserId: string): Promise<{ good: number; total: number; people: number }> {
  const where = and(gte(doctorDeskRatings.workDate, from), lte(doctorDeskRatings.workDate, to), ne(doctorDeskRatings.ratedUserId, exceptUserId),
    departmentId === null ? undefined : eq(doctorDeskRatings.departmentId, departmentId));
  const all = (await db.select({ total: count(), people: countDistinct(doctorDeskRatings.ratedUserId) }).from(doctorDeskRatings).where(where))[0];
  const good = (await db.select({ n: count() }).from(doctorDeskRatings).where(and(where, eq(doctorDeskRatings.rating, "good"))))[0];
  return { good: good?.n ?? 0, total: all?.total ?? 0, people: all?.people ?? 0 };
}

/** An average share, rounded to the nearest 5 % so one rating more or less cannot be read off it. */
export const roundToFive = (n: number): number => Math.round(n / 5) * 5;
const poolShare = (p: { good: number; total: number; people: number }): number | null =>
  p.people < RATING_MIN_POOL_PEOPLE ? null : (() => { const s = goodShare(p.good, p.total, RATING_MIN_POOL_RATINGS); return s === null ? null : roundToFive(s); })();

/** The resident's own month, beside the department's and the hospital's share rated Good. No names. */
export async function myRatings(db: Db, actor: Actor, at: Date): Promise<WireMyRatings> {
  const scope = await deskScope(db, actor, at);
  const { month, from, to } = monthBounds(scope.istDate);
  const settled = addIstDays(scope.istDate, -1); // the pools read settled days only
  const own = await db.select().from(doctorDeskRatings)
    .where(and(eq(doctorDeskRatings.ratedUserId, actor.id), gte(doctorDeskRatings.workDate, from), lte(doctorDeskRatings.workDate, to)))
    .orderBy(desc(doctorDeskRatings.workDate), desc(doctorDeskRatings.createdAt));
  const counts = { good: 0, fine: 0, needs_rework: 0, total: own.length };
  for (const r of own) counts[r.rating as WorkRating] += 1;
  const department = own[0]?.departmentId ?? scope.unit?.departmentId ?? null;
  return {
    month, counts,
    share: {
      you: goodShare(counts.good, counts.total, RATING_MIN_OWN),
      department: department === null ? null : poolShare(await pool(db, from, settled, department, actor.id)),
      hospital: poolShare(await pool(db, from, settled, null, actor.id)),
    },
    recent: own.slice(0, 20).map((r) => ({ workDate: r.workDate, workKind: "opd_visit" as const, rating: r.rating as WorkRating, reason: r.reason })),
  };
}

/** A cell, quoted when it must be; a leading = + - @ is defused so a spreadsheet never runs it as a formula. */
const csvCell = (raw: string): string => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
const RATING_WORDS: Record<WorkRating, string> = { good: "Good", fine: "Fine", needs_rework: "Needs rework" };

/** The resident's own PG logbook lines: date, work, visit, rating, reason. No rater, no patient. */
export async function logbookCsv(db: Db, actor: Actor): Promise<string> {
  const rows = await db.select().from(doctorDeskRatings).where(eq(doctorDeskRatings.ratedUserId, actor.id))
    .orderBy(desc(doctorDeskRatings.workDate), desc(doctorDeskRatings.createdAt));
  const visits = new Map((await completedVisitsOf(db, [actor.id], [...new Set(rows.map((r) => r.workDate))])).map((v) => [v.encounterId, v.visitNo] as const));
  const lines = [["date", "work", "visit", "rating", "reason"].join(",")];
  for (const r of rows) {
    lines.push([r.workDate, "OPD visit", visits.get(r.workId) ?? "", RATING_WORDS[r.rating as WorkRating], r.reason ?? ""].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
