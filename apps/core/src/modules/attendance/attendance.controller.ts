import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { teamOf } from "../../kernel/desk/home.controller";
import { appendEvent } from "../../kernel/events/append";
import { users } from "../../kernel/db/schema";
import { attendanceRead } from "./events";
import { isIsoDate, istDate } from "./ist";
import { ATTENDANCE_ALL_READ } from "./manifest";
import {
  AttendanceRangeError, daysOfPins, needsConfirm, peopleOfUsers, personOf, personOfUser, personRange, punchesOf, readRange, selfDays, selfToday, summary, syncState,
  todayList, todayOf, unlinkedReason,
} from "./reads";
import { MAX_OPEN_REQUESTS, NOTE_MAX, RequestError, closeRequest, listRequests, markSeen, ownRequests, requestMeeting } from "./requests";
import { apiKeyOf } from "./secrets";
import { MarkError, latestMarks, markAttendance, marksOfPins, selfMarks } from "./marks";
import type { MarkView, SelfMarkView } from "./marks";
import { inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { OwnRequestView, RequestView } from "./requests";
import type {
  ConfirmReason, CountsByStatus, DayView, PersonView, SelfWord, PunchView, RangeView, SelfDayView, SelfTodayView, SummaryGroup, SyncStateView, TodayRow, TodayView,
  UnlinkedReason,
} from "./reads";

const rangeQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
const todayQuery = z.object({ dept: z.string().min(1).max(120).optional() });
const punchesQuery = z.object({ date: z.string().optional() });
const note = z.string().trim().max(NOTE_MAX).optional().transform((v) => (v === undefined || v === "" ? null : v));
const requestBody = z.object({ date: z.string(), note }).strict();
const closeBody = z.object({ note }).strict();
const requestsQuery = z.object({ status: z.enum(["open", "seen", "closed"]).optional() });
const summaryQuery = rangeQuery.extend({ groupBy: z.enum(["dept", "status", "day"]).optional() });
/** The phone's one reading, or null when it has none. Nothing else is accepted — and none of it is kept (`marks.ts`). */
const markBody = z.object({
  location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), mocked: z.boolean().default(false) }).strict().nullable(),
}).strict();

function q<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequestException({ code: "bad_query" });
  return r.data;
}
function rangeOf(query: { from?: string; to?: string }, today: string): { from: string; to: string } {
  try { return readRange(query, today); } catch (e) {
    if (e instanceof AttendanceRangeError) throw new BadRequestException({ code: e.code });
    throw e;
  }
}

/** A person's OWN attendance: five words, "checked in", and (planned) leave, roster and holidays. Times only when the setting says so. */
export type SelfRange = { person: PersonView; from: string; to: string; today: SelfTodayView; days: SelfDayView[]; needsConfirm: string[]; marks: SelfMarkView[] } & Omit<RangeView, "days">;
function requestHttp(e: unknown): never {
  if (!(e instanceof RequestError)) throw e;
  if (e.code === "unknown_request") throw new NotFoundException({ code: e.code });
  if (e.code === "too_many_open_requests") throw new HttpException({ code: e.code, max: MAX_OPEN_REQUESTS }, 429);
  throw new ConflictException({ code: e.code });
}

/** `leadsTeam` tells the app whether to offer "My team" — so a person who leads nobody never asks a manager route. */
export type MeResponse =
  | { linked: false; reason: UnlinkedReason; configured: boolean; leadsTeam: boolean }
  | ({ linked: true; configured: boolean; leadsTeam: boolean; showsTimes: boolean } & SelfRange);
export type TeamMemberToday = { userId: string; name: string; linked: boolean; pin: string | null; today: Omit<TodayRow, keyof PersonView | "hasLogin"> | null; appMark: MarkView | null };

/**
 * ═══ THE ATTENDANCE READ ROUTES — THREE AUDIENCES, ONE COPY ═══
 *
 *   everyone signed in   their OWN linked attendance (`/attendance/me…`) — no permission, and no
 *                        parameter that could name anybody else;
 *   a unit head or       their own TEAM's (`/attendance/team…`) — the team is computed from the
 *   an in-charge         caller (`teamOf`), so there is nothing to grant and nothing to ask for;
 *   the owner and the    EVERYONE on the machine's list, with or without an HMIS login
 *   Attendance Committee (`attendance.all.read`).
 *
 * `/attendance/person/:pin` is the one route that takes somebody's pin, and it admits exactly those
 * three cases: the caller's own pin, a pin on the caller's team, or `attendance.all.read`.
 *
 * All GET but the meeting requests (a person asks to meet about a "Confirm" day; the committee marks
 * it seen and closes it). A read of OTHER people's rows writes one `attendance.read` event (who, which view, how
 * many — the staff-report drill's shape). Reading your own is not an event, and neither are the
 * counts-only summary or the sync state: there is no person in them.
 *
 * NO ROUTE RETURNS A MOBILE NUMBER OR AN AADHAAR HASH — `reads.ts` selects neither.
 *
 * APP MARKS (decision 0061) ride along with the machine's data on every route above: the person sees
 * their own as words, a manager sees each with its time, place and metres. No route has a coordinate
 * to return: none is stored.
 */
@Controller("attendance")
export class AttendanceController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private configured(): boolean { return apiKeyOf(this.cfg.attendance) !== null; }

  private async audit(actor: Actor, payload: { view: "today" | "person" | "team_today" | "team"; scope: "all" | "team"; subjectPin: string | null; from: string; to: string; people: number; rows: number }): Promise<void> {
    await withTx(this.db, (tx) => appendEvent(tx, attendanceRead.make({ actor, payload })));
  }

  @Get("me")
  async me(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<MeResponse> {
    const today = istDate(new Date());
    const { from, to } = rangeOf(q(rangeQuery, query), today);
    const configured = this.configured();
    if (actor.type !== "user") return { linked: false, reason: "no_match", configured, leadsTeam: false };
    const leadsTeam = (await teamOf(this.db, actor.id, new Date())).userIds.length > 0;
    const person = await personOfUser(this.db, actor.id);
    if (person === null) return { linked: false, reason: await unlinkedReason(this.db, actor.id), configured, leadsTeam };
    return { linked: true, configured, leadsTeam, showsTimes: this.cfg.attendance.selfShowsTimes, ...(await this.selfRange(actor.id, person, from, to, today)) };
  }

  /**
   * THE SELF SHAPE (owner 2026-10-09): per day ONE of five words; today only "checked in". The times
   * are not in the payload at all unless `ATTENDANCE_SELF_SHOWS_TIMES` is on — hidden-by-the-app is
   * not hidden. `/attendance/me` and a plain person asking for their own pin both answer with this.
   */
  private async selfRange(userId: string, person: PersonView, from: string, to: string, today: string): Promise<SelfRange> {
    const withTimes = this.cfg.attendance.selfShowsTimes;
    const { leaves, roster, holidays } = await personRange(this.db, person, from, to);
    return {
      person, from, to, today: await selfToday(this.db, person.pin, today, withTimes),
      days: await selfDays(this.db, person.pin, from, to, today, withTimes),
      needsConfirm: await needsConfirm(this.db, person.pin, today), marks: await selfMarks(this.db, userId, from, to), leaves, roster, holidays,
    };
  }

  @Get("me/punches")
  async myPunches(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ linked: boolean; date: string; showsTimes: boolean; status: SelfWord | null; reason?: ConfirmReason; punches?: PunchView[] }> {
    const today = istDate(new Date());
    const date = q(punchesQuery, query).date ?? today;
    if (!isIsoDate(date) || date > today) throw new BadRequestException({ code: "bad_date" });
    const showsTimes = this.cfg.attendance.selfShowsTimes;
    const person = actor.type === "user" ? await personOfUser(this.db, actor.id) : null;
    if (person === null) return { linked: false, date, showsTimes, status: null };
    // With the setting off this is the day's word and NOTHING else: no `punches` key at all.
    const day = (await selfDays(this.db, person.pin, date, date, today, false))[0];
    return { linked: true, date, showsTimes, status: day?.status ?? null, ...(day?.reason === undefined ? {} : { reason: day.reason }), ...(showsTimes ? { punches: await punchesOf(this.db, person.pin, date) } : {}) };
  }

  /**
   * "MARK ATTENDANCE" (owner 2026-10-10, decision 0061) — In, or Out after an In. The answer is words
   * only, like every self route. The body's reading is reduced to a place and metres in `marks.ts` and
   * goes no further: a refused body says only `bad_body`, never what it held.
   */
  @Post("me/marks")
  @HttpCode(200)
  async mark(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ created: boolean; mark: SelfMarkView }> {
    const r = markBody.safeParse(body);
    if (!r.success) throw new BadRequestException({ code: "bad_body" });
    if (actor.type !== "user") throw new ForbiddenException();
    return markAttendance(this.db, actor.id, r.data.location, this.cfg.attendanceSite, new Date()).catch((e: unknown) => {
      if (!(e instanceof MarkError)) throw e;
      if (e.code === "too_many_marks") throw new HttpException({ code: e.code }, 429);
      throw new ConflictException({ code: e.code });
    });
  }

  /**
   * "CONFIRM" → "REQUEST MEETING" (owner 2026-10-09). Only about one of the caller's OWN days that
   * reads `confirm`; asking twice returns the first request; at most five open per person. Whoever
   * holds the Attendance Committee role is told, in fixed words.
   */
  @Post("me/requests")
  @HttpCode(200)
  async askToMeet(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ created: boolean; request: OwnRequestView }> {
    const b = q(requestBody, body);
    const now = new Date();
    const today = istDate(now);
    if (!isIsoDate(b.date) || b.date >= today) throw new BadRequestException({ code: "bad_date" });
    if (actor.type !== "user") throw new ForbiddenException();
    return requestMeeting(this.db, actor.id, { date: b.date, note: b.note }, today, now).catch(requestHttp);
  }

  @Get("me/requests")
  async myRequests(@CurrentActor() actor: Actor): Promise<{ requests: OwnRequestView[] }> {
    return { requests: actor.type === "user" ? await ownRequests(this.db, actor.id) : [] };
  }

  /** The committee's and the owner's queue. DECIDED: whoever may see everyone's attendance may handle a request about it. */
  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Get("requests")
  async requests(@Query() query: unknown): Promise<{ status: "open" | "seen" | "closed"; requests: RequestView[] }> {
    const status = q(requestsQuery, query).status ?? "open";
    return { status, requests: await listRequests(this.db, status, new Date()) };
  }

  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Post("requests/:id/seen")
  @HttpCode(200)
  async seen(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ request: OwnRequestView }> {
    return { request: await markSeen(this.db, actor, id, new Date()).catch(requestHttp) };
  }

  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Post("requests/:id/close")
  @HttpCode(200)
  async close(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ request: OwnRequestView }> {
    const b = q(closeBody, body ?? {});
    return { request: await closeRequest(this.db, actor, id, b.note, new Date()).catch(requestHttp) };
  }

  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Get("today")
  async today(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{
    date: string; configured: boolean; people: (TodayRow & { appMark: MarkView | null })[]; summary: { total: number; byStatus: CountsByStatus; byDept: { dept: string | null; total: number; byStatus: CountsByStatus }[] };
  }> {
    const date = istDate(new Date());
    const { dept } = q(todayQuery, query);
    const list = await todayList(this.db, date, dept === undefined ? {} : { dept });
    await this.audit(actor, { view: "today", scope: "all", subjectPin: null, from: date, to: date, people: list.people.length, rows: list.people.length });
    const marks = await latestMarks(this.db, date);
    return { date, configured: this.configured(), people: list.people.map((p) => ({ ...p, appMark: marks.get(p.pin) ?? null })), summary: { total: list.people.length, byStatus: list.byStatus, byDept: list.byDept } };
  }

  @Get("person/:pin")
  async person(@CurrentActor() actor: Actor, @Param("pin") pin: string, @Query() query: unknown): Promise<({ detail: "full"; person: PersonView; from: string; to: string; today: TodayView; marks: MarkView[] } & RangeView) | ({ detail: "self"; showsTimes: boolean } & SelfRange)> {
    const today = istDate(new Date());
    const { from, to } = rangeOf(q(rangeQuery, query), today);
    if (actor.type !== "user") throw new ForbiddenException();
    const found = await personOf(this.db, pin);
    // WHO MAY — decided before "does this pin exist" is answered, so a caller with no right to a pin
    // learns nothing from asking, not even whether it is on the machine.
    const own = found !== null && found.userId === actor.id;
    const all = await hasPermission(this.db, actor.id, ATTENDANCE_ALL_READ, "hospital");
    const team = own || all || found === null || found.userId === null ? false : (await teamOf(this.db, actor.id, new Date())).userIds.includes(found.userId);
    if (!own && !all && !team) throw new ForbiddenException();
    if (found === null) throw new NotFoundException({ code: "unknown_pin" });
    const person: PersonView = { pin: found.pin, name: found.name, dept: found.dept, post: found.post };
    // THE SELF SHAPE CANNOT BE BYPASSED THROUGH THIS DOOR: somebody asking for their OWN pin gets
    // the machine's full detail only as a manager (`attendance.all.read`). `teamOf` never puts a
    // person on their own team, so leading a team does not open one's own times either.
    if (own && !all) return { detail: "self", showsTimes: this.cfg.attendance.selfShowsTimes, ...(await this.selfRange(actor.id, person, from, to, today)) };
    const range = await personRange(this.db, person, from, to);
    if (!own) await this.audit(actor, { view: "person", scope: all ? "all" : "team", subjectPin: pin, from, to, people: 1, rows: range.days.length });
    const marks = (await marksOfPins(this.db, [pin], from, to)).get(pin) ?? [];
    return { detail: "full", person, from, to, today: await todayOf(this.db, pin, today), marks, ...range };
  }

  /** The caller's team, or 403 when they lead nobody. Names come from HMIS (`users`), so an unlinked member is still named. */
  private async team(actor: Actor): Promise<{ members: { userId: string; name: string; person: PersonView | null }[] }> {
    if (actor.type !== "user") throw new ForbiddenException();
    const { userIds } = await teamOf(this.db, actor.id, new Date());
    if (userIds.length === 0) throw new ForbiddenException({ code: "no_team" });
    const names = await this.db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, userIds));
    const people = await peopleOfUsers(this.db, userIds);
    const members = names.map((n) => {
      const p = people.find((x) => x.userId === n.id);
      return { userId: n.id, name: n.fullName, person: p === undefined ? null : { pin: p.pin, name: p.name, dept: p.dept, post: p.post } };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { members };
  }

  @Get("team/today")
  async teamToday(@CurrentActor() actor: Actor): Promise<{ date: string; members: TeamMemberToday[]; summary: { total: number; linked: number; byStatus: CountsByStatus } }> {
    const date = istDate(new Date());
    const { members } = await this.team(actor);
    const pins = members.flatMap((m) => (m.person === null ? [] : [m.person.pin]));
    const list = await todayList(this.db, date, { pins });
    const marks = await latestMarks(this.db, date, pins);
    const out: TeamMemberToday[] = members.map((m) => {
      const row = m.person === null ? undefined : list.people.find((p) => p.pin === m.person!.pin);
      return {
        userId: m.userId, name: m.name, linked: m.person !== null, pin: m.person?.pin ?? null,
        today: row === undefined ? null : { status: row.status, known: row.known, firstIn: row.firstIn, lastOut: row.lastOut, onDuty: row.onDuty },
        appMark: m.person === null ? null : marks.get(m.person.pin) ?? null,
      };
    });
    await this.audit(actor, { view: "team_today", scope: "team", subjectPin: null, from: date, to: date, people: members.length, rows: list.people.length });
    return { date, members: out, summary: { total: members.length, linked: pins.length, byStatus: list.byStatus } };
  }

  @Get("team")
  async teamRange(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ from: string; to: string; members: { userId: string; name: string; linked: boolean; pin: string | null; days: DayView[]; marks: MarkView[] }[] }> {
    const today = istDate(new Date());
    const { from, to } = rangeOf(q(rangeQuery, query), today);
    const { members } = await this.team(actor);
    const pins = members.flatMap((m) => (m.person === null ? [] : [m.person.pin]));
    const days = await daysOfPins(this.db, pins, from, to);
    const marks = await marksOfPins(this.db, pins, from, to);
    const out = members.map((m) => ({
      userId: m.userId, name: m.name, linked: m.person !== null, pin: m.person?.pin ?? null,
      days: m.person === null ? [] : days.get(m.person.pin) ?? [], marks: m.person === null ? [] : marks.get(m.person.pin) ?? [],
    }));
    await this.audit(actor, { view: "team", scope: "team", subjectPin: null, from, to, people: members.length, rows: out.reduce((n, m) => n + m.days.length, 0) });
    return { from, to, members: out };
  }

  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Get("summary")
  async summary(@Query() query: unknown): Promise<{ from: string; to: string; groupBy: "dept" | "status" | "day"; groups: SummaryGroup[] }> {
    const parsed = q(summaryQuery, query);
    const { from, to } = rangeOf(parsed, istDate(new Date()));
    const groupBy = parsed.groupBy ?? "status";
    return { from, to, groupBy, groups: await summary(this.db, from, to, groupBy) };
  }

  /** So a screen can say "as of 16:20" or "not connected". Names and times of the sync — no key, no URL, no error text. */
  @RequirePermission(ATTENDANCE_ALL_READ, "hospital")
  @Get("sync-state")
  async syncState(): Promise<{ configured: boolean; enabled: boolean } & SyncStateView> {
    return { configured: this.configured(), enabled: this.cfg.attendance.syncEnabled, ...(await syncState(this.db)) };
  }
}
