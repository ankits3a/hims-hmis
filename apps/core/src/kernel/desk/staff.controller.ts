import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../tokens";
import { istDayString as istDay } from "../approvals/cumulative";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { users } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { collectDeskProviders, loadReport } from "./registry";
import {
  PERIODS, baselineWindowFor, buildBrief, needsBaseline, oldestDayRead, windowFor,
} from "./brief";
import { assertWithinHorizon, horizonFor } from "./horizon";
import { RANGE_DIMENSIONS } from "./range";
import { loadRange } from "./registry";
import type { RangeDimension, RangeRow } from "./range";
import { factsForWindow, sumWindow } from "./rollup";
import { staffReportDrilled } from "./events";
import { DeskError } from "./types";
import { parsed, toHttp } from "./http";
import { eq, inArray } from "drizzle-orm";
import type { Brief } from "./brief";
import type { ReportSection } from "./types";
import type { ModuleRegistry } from "../modules/loader";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 07c T9 / DD14 — **WHAT, NOT WHOM.**
 *
 * O-2 was ruled YES on 2026-08-28: a supervisor may see a named staff member's day. DD14 is the
 * constraint that keeps that both lawful and useful, and this controller is where it is enforced
 * rather than described:
 *
 *   - `GET /staff` and `GET /staff/:userId/brief` return **counts, money and comparisons**. They
 *     cannot leak a patient, and that is STRUCTURAL rather than careful: they are built from
 *     `facts`, which is `Record<string, number>` — there is no field in the response that could
 *     hold a name. Staff activity is hospital work product; patient identity is not.
 *   - `POST /staff/:userId/drill` is the only route that returns rows. It carries its own
 *     permission, refuses without a stated reason, and writes `staff_report.drilled` naming the
 *     supervisor — so the audit trail covers the auditor.
 *
 * ═══ THE DRILL READS AS THE SUPERVISOR, NOT AS THE SUBJECT ═══
 *
 * The rows belong to the clerk and the VISIBILITY belongs to the supervisor: `ctx.actor` is the
 * subject (every provider filters its tables on it) and `ctx.reader` is the supervisor (every
 * provider aliases patients through it). Collapsing the two would hand the supervisor the clerk's
 * confidentiality clearance — see `DeskProviderCtx.reader`, which exists for exactly this.
 */
const briefQuery = z.object({
  date: z.string().length(10).optional(),
  period: z.enum(PERIODS).optional(),
});
/**
 * PHASE STAFF-REPORTS T3 — the breakdown request. `groupBy` is a comma list so the whole query is
 * a URL a person can bookmark, mail, and paste into a bug report.
 */
const csvList = (max: number) => z.string().transform((v) => v.split(",").map((x) => x.trim()).filter((x) => x !== ""))
  .refine((v) => v.length > 0 && v.length <= max, `expected 1..${String(max)} comma-separated values`);

const rangeQuery = z.object({
  from: z.string().length(10),
  to: z.string().length(10),
  groupBy: csvList(RANGE_DIMENSIONS.length)
    .refine((v): v is RangeDimension[] => v.every((d) => (RANGE_DIMENSIONS as readonly string[]).includes(d)),
      `each groupBy must be one of ${RANGE_DIMENSIONS.join(", ")}`)
    .optional(),
  userIds: csvList(200).optional(),
  departmentId: z.string().optional(),
  doctorId: z.string().optional(),
  visitType: z.enum(["new", "revisit", "renewal"]).optional(),
});

const drillBody = z.object({
  date: z.string().length(10),
  /** A reason box that can be satisfied by pressing Enter is a control nobody has thought about. */
  reason: z.string().trim().min(8),
});

@Controller("staff")
export class StaffController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  /**
   * The staff a supervisor may read, and it is deliberately every ACTIVE user rather than a
   * reporting line — `manifest.ts` records that decision and why a fabricated hierarchy would be
   * worse than an explicit grant. Inactive users are excluded because a leaver's day is a
   * historical question, not a supervision one, and the list is a picker rather than an archive.
   */
  @Get()
  @RequirePermission("staff.reports.read", "hospital")
  async staff(): Promise<{ items: { id: string; username: string; fullName: string }[] }> {
    const items = await this.db
      .select({ id: users.id, username: users.username, fullName: users.fullName })
      .from(users)
      .where(eq(users.active, true));
    return { items: [...items].sort((a, b) => (a.fullName < b.fullName ? -1 : 1)) };
  }

  /**
   * A NAMED PERSON'S FIGURES. No patient can appear here: the response is a brief plus a bag of
   * integers, and `DeskProvider.facts` cannot return anything else — `liveFactsFor` refuses a value
   * that is not a non-negative integer.
   */
  /**
   * ═══ PHASE STAFF-REPORTS T3 — THE BREAKDOWN. THE SECOND INSTRUMENT, OVER HTTP ═══
   *
   * `:userId/brief` answers "how did this person's month go" from the cached pulse. This answers
   * "who registered how many, for which department, under which doctor, split new / revisit /
   * renewal" — live, across people, over a range the caller picked. `range.ts` carries the argument
   * for why those are two instruments rather than one.
   *
   * DECLARED BEFORE THE `:userId` ROUTES so a literal path segment can never be read as an id.
   *
   * ═══ IT RETURNS IDS FOR DEPARTMENT AND DOCTOR, AND NAMES ONLY FOR PEOPLE ═══
   *
   * The kernel owns `users`, so it can label a person. It does NOT own `opd_departments` or
   * `opd_doctors`, and reaching into a module's tables to pretty-print a heading would invert the
   * dependency the whole `DeskProvider` seam exists to keep pointing one way. The client already
   * holds those masters for its own pickers, and labelling is its job.
   *
   * ═══ NO `report.exported` EVENT HERE, AND THAT IS NOT AN OVERSIGHT ═══
   *
   * This route returns COUNTS — `mergeBuckets` refuses anything that is not a non-negative integer,
   * so there is no field in the response that could carry a patient. It is the same reasoning DD14
   * applies to the brief: the figures need no audit row because they cannot name anybody. The CSV
   * (T6) and the MRD register (T7) are a different matter and carry their own.
   */
  @Get("range")
  @RequirePermission("staff.reports.read", "hospital")
  async range(
    @CurrentActor() reader: Actor, @Query() query: unknown,
  ): Promise<{ from: string; to: string; groupBy: RangeDimension[]; rows: RangeRow[]; totals: Record<string, number>; users: Record<string, string> }> {
    const q = parsed(rangeQuery, query);
    const now = new Date();
    const groupBy: RangeDimension[] = q.groupBy ?? ["userId"];
    /*
     * THE HORIZON BINDS `from` — the oldest day this request will read. A range route without this
     * would be the widest hole in the ruling: every other door is capped by a PERIOD, and this one
     * lets the caller name any date they like.
     */
    await this.assertMayReach(reader, q.from, now);

    const { rows, totals } = await loadRange(collectDeskProviders(this.registry), {
      db: this.db, reader, now, groupBy,
      filters: {
        from: q.from, to: q.to, userIds: q.userIds,
        departmentId: q.departmentId, doctorId: q.doctorId, visitType: q.visitType,
      },
    }).catch(toHttp);

    return { from: q.from, to: q.to, groupBy, rows, totals, users: await this.userNames(rows) };
  }

  /**
   * The people named in the rows, by id. Only the ones the report actually mentions — a hospital's
   * whole staff list is `GET /staff`, and a report should not become a second directory.
   */
  private async userNames(rows: readonly RangeRow[]): Promise<Record<string, string>> {
    const ids = [...new Set(rows.map((r) => r.key.userId).filter((v): v is string => v !== undefined))];
    if (ids.length === 0) return {};
    const found = await this.db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, ids));
    return Object.fromEntries(found.map((u) => [u.id, u.fullName]));
  }

  @Get(":userId/brief")
  @RequirePermission("staff.reports.read", "hospital")
  async brief(
    @CurrentActor() reader: Actor, @Param("userId") userId: string, @Query() query: unknown,
  ): Promise<Brief & { subjectUserId: string; totalsToday: Record<string, number> }> {
    const q = parsed(briefQuery, query);
    const now = new Date();
    const today = q.date ?? istDay(now);
    const period = q.period ?? "week";
    await this.requireSubject(userId).catch(toHttp);
    await this.assertMayReach(reader, oldestDayRead(period, today), now);

    const subject: Actor = { type: "user", id: userId };
    const providers = collectDeskProviders(this.registry);
    const w = windowFor(period, today);
    /* T0 — read the baseline only where it is consumed; see `needsBaseline` and `DeskController`. */
    const b = needsBaseline(period) ? baselineWindowFor(period, today) : null;
    const [days, baseline] = await Promise.all([
      factsForWindow(this.db, providers, subject, w.from, w.to, today, now),
      b === null
        ? Promise.resolve([])
        : factsForWindow(this.db, providers, subject, b.from, b.to, today, now),
    ]);
    const todayFacts = days.find((d) => d.day === today);
    return {
      ...buildBrief(period, today, days, baseline),
      subjectUserId: userId,
      totalsToday: todayFacts === undefined ? {} : sumWindow([todayFacts]),
    };
  }

  /**
   * ═══ THE DRILL. A POST, AND THAT IS NOT REST PEDANTRY ═══
   *
   * It WRITES — an audit row naming the supervisor, the subject, the day and the reason — and a GET
   * that writes is a GET that gets retried by a proxy, prefetched by a browser and replayed from a
   * log. It also carries a reason in its body, which does not belong in a URL that lands in an
   * access log next to a staff member's id.
   *
   * The event is appended BEFORE the rows are returned, on the reasoning `kernel/search/audit.ts`
   * already records: a log that captures only the reads that finished cannot answer for the ones
   * that did not.
   */
  @Post(":userId/drill")
  @RequirePermission("staff.reports.drill", "hospital")
  async drill(
    @CurrentActor() actor: Actor, @Param("userId") userId: string, @Body() body: unknown,
  ): Promise<{ subjectUserId: string; date: string; sections: ReportSection[] }> {
    const b = parsed(drillBody, body);
    const now = new Date();
    await this.requireSubject(userId).catch(toHttp);
    if (actor.type !== "user") toHttp(new DeskError("user_actor_required", "a drill is a person's act"));
    /*
     * THE DRILL IS ONE DAY, AND THAT DAY CAN BE ANY DAY. A route that reads a single date looks
     * bounded and is not: `date` is a free parameter, so without this a capped supervisor reaches
     * four years back one day at a time.
     */
    await this.assertMayReach(actor, b.date, now);
    /**
     * A SUPERVISOR DRILLING THEMSELVES IS NOT A DRILL, and it must not be refused either: it is
     * their own day, which `/me/report` already serves. Refusing would be a puzzle; logging it as a
     * cross-staff read would put noise in the register that somebody has to triage. It is allowed
     * and it is recorded like any other, because "who looked at whom" is a question the register
     * should answer literally rather than cleverly.
     */
    const subject: Actor = { type: "user", id: userId };
    const providers = collectDeskProviders(this.registry);
    const { sections } = await loadReport(providers, {
      db: this.db, actor: subject, reader: actor, date: b.date, now,
    });
    const rows = sections.reduce((n, s) => n + s.rows.length, 0);
    await withTx(this.db, (tx) =>
      appendEvent(tx, staffReportDrilled.make({
        actor,
        payload: { subjectUserId: userId, date: b.date, reason: b.reason, sections: sections.length, rows },
      })));
    return { subjectUserId: userId, date: b.date, sections };
  }

  /**
   * T0 — THE HISTORY HORIZON, READ OFF THE CALLER AND NEVER OFF THE SUBJECT.
   *
   * This is the same split `DeskProviderCtx` draws between `actor` (whose rows) and `reader` (whose
   * visibility), for the same reason its header gives: collapse them and the reader inherits the
   * subject's clearance. A supervisor capped at a year must not reach two years back merely because
   * the clerk they are reading holds `staff.reports.history.full` themselves.
   */
  private async assertMayReach(reader: Actor, oldestDay: string, now: Date): Promise<void> {
    const horizon = await horizonFor(this.db, reader, istDay(now));
    try {
      assertWithinHorizon(oldestDay, horizon);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * The subject must be a real, active user. Without this a typo'd id returns an empty brief that
   * reads as "this person did nothing", which is the one answer a supervisor must never be given by
   * accident — it is indistinguishable from a person who did nothing.
   */
  private async requireSubject(userId: string): Promise<void> {
    const rows = await this.db.select({ active: users.active }).from(users).where(eq(users.id, userId));
    if (rows.length === 0) throw new DeskError("unknown_user", "no such user");
    if (!rows[0]!.active) throw new DeskError("inactive_user", "that account is no longer active");
  }
}
