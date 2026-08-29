import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../tokens";
import { istDayString as istDay } from "../approvals/cumulative";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { users } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { collectDeskProviders, loadReport } from "./registry";
import { baselineWindowFor, buildBrief, windowFor } from "./brief";
import { factsForWindow, sumWindow } from "./rollup";
import { staffReportDrilled } from "./events";
import { DeskError } from "./types";
import { parsed, toHttp } from "./http";
import { eq } from "drizzle-orm";
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
  period: z.enum(["day", "week", "month", "quarter", "half"]).optional(),
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
  @Get(":userId/brief")
  @RequirePermission("staff.reports.read", "hospital")
  async brief(
    @Param("userId") userId: string, @Query() query: unknown,
  ): Promise<Brief & { subjectUserId: string; totalsToday: Record<string, number> }> {
    const q = parsed(briefQuery, query);
    const now = new Date();
    const today = q.date ?? istDay(now);
    const period = q.period ?? "week";
    await this.requireSubject(userId).catch(toHttp);

    const subject: Actor = { type: "user", id: userId };
    const providers = collectDeskProviders(this.registry);
    const w = windowFor(period, today);
    const b = baselineWindowFor(period, today);
    const [days, baseline] = await Promise.all([
      factsForWindow(this.db, providers, subject, w.from, w.to, today, now),
      factsForWindow(this.db, providers, subject, b.from, b.to, today, now),
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
