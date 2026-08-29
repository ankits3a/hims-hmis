import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../tokens";
import { istDayString as istDay } from "../approvals/cumulative";
import { CurrentActor } from "../auth/decorators";
import { collectDeskProviders, loadDesk, loadReport } from "./registry";
import { parsed } from "./http";
import { baselineWindowFor, buildBrief, windowFor } from "./brief";
import { factsForWindow } from "./rollup";
import type { Brief } from "./brief";
import { contentDisposition, toCsv } from "../report/csv";
import { reportExported } from "../report/events";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import type { DeskCard, ReportSection } from "./types";
import type { Response } from "express";
import type { ModuleRegistry } from "../modules/loader";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 07c T2 A4 / E-5 — A REPORT FOR A DAY THAT IS STILL HAPPENING SAYS SO.
 *
 * A shift report is printed, signed and filed. One pulled at 14:00 and one pulled at 21:00 are
 * different documents with the same title and the same date, and the mid-shift one is not the
 * close — it is a snapshot that will be wrong within the hour. The word for that is PROVISIONAL,
 * and it belongs to the SERVER rather than to the screen: the screen, the print and the CSV are
 * three renderings of one model (DD5), and a flag computed in each of them is three chances for the
 * paper in the file to disagree with the file on the disk.
 *
 * A FUTURE date is provisional too, and deliberately so — nothing about it is settled yet, and the
 * alternative (calling an empty future day "final") is the one reading that is definitely wrong.
 */
function isProvisional(date: string, now: Date): boolean {
  return date >= istDay(now);
}

const deskQuery = z.object({ date: z.string().length(10).optional() });
const briefQuery = z.object({
  date: z.string().length(10).optional(),
  period: z.enum(["day", "week", "month", "quarter", "half"]).optional(),
});

/**
 * PLAN 07c T1 — THE DESK, IN ONE REQUEST.
 *
 * THE ROUTE CARRIES NO `@RequirePermission`, AND THAT IS THE SAME DECISION `/search` MADE. Its whole
 * job is to describe what this actor may do; a permission on the route would be a permission on
 * asking the question, and the answer for somebody who holds nothing is an empty desk — which is
 * information, not a refusal. Every CARD is permission-gated individually inside `loadDesk`, and
 * gated BEFORE it runs rather than after, so no provider reads data for a card its caller may not
 * see.
 *
 * ONE REQUEST is the point. The OPD desk this replaces fired a dozen and polled three of them; a
 * home screen that costs twelve round trips is a home screen people avoid.
 */
@Controller("me")
export class DeskController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get("desk")
  async desk(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ date: string; cards: DeskCard[] }> {
    const q = parsed(deskQuery, query);
    const now = new Date();
    const date = q.date ?? istDay(now);
    /**
     * An AGENT gets an empty desk rather than an error, matching `/auth/me`'s own reasoning: agents
     * hold no permissions at all, so "what is on this actor's desk" has the answer `nothing`, and
     * returning it is more honest than a 403 on a route whose job is to describe the caller.
     */
    if (actor.type !== "user") return { date, cards: [] };
    const providers = collectDeskProviders(this.registry);
    return { date, ...(await loadDesk(providers, { db: this.db, actor, reader: actor, date, now })) };
  }

  /**
   * PLAN 07c T2 — THE PERSON'S OWN DAY. There is NO `userId` parameter, and that is the whole of
   * the authority model: you cannot ask for somebody else's, because there is nowhere to put their
   * id. Self-scoping is structural rather than a check a later edit can drop.
   */
  @Get("report")
  async report(
    @CurrentActor() actor: Actor, @Query() query: unknown,
  ): Promise<{ date: string; provisional: boolean; sections: ReportSection[] }> {
    const q = parsed(deskQuery, query);
    const now = new Date();
    const date = q.date ?? istDay(now);
    const provisional = isProvisional(date, now);
    if (actor.type !== "user") return { date, provisional, sections: [] };
    const providers = collectDeskProviders(this.registry);
    return { date, provisional, ...(await loadReport(providers, { db: this.db, actor, reader: actor, date, now })) };
  }

  /**
   * PLAN 07c T8 — THE FIVE-PERIOD BRIEF, and it is `/me/…` for the same reason the report is:
   * there is no `userId`, so there is no version of this route that reads a colleague's history.
   *
   * The long windows are summed from `user_day_facts`; TODAY is computed live and marked
   * provisional, so a brief opened at 11am is a true statement about a day that is still happening
   * rather than a stale one about a day that is not (A3).
   */
  @Get("brief")
  async brief(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<Brief> {
    const q = parsed(briefQuery, query);
    const now = new Date();
    const today = q.date ?? istDay(now);
    const period = q.period ?? "week";
    if (actor.type !== "user") return buildBrief(period, today, [], []);

    const providers = collectDeskProviders(this.registry);
    const w = windowFor(period, today);
    const b = baselineWindowFor(period, today);
    const [days, baseline] = await Promise.all([
      factsForWindow(this.db, providers, actor, w.from, w.to, today, now),
      /*
       * THE BASELINE IS READ FROM THE ROLLUP ONLY — it ends strictly before the window starts, so
       * it contains no "today" and needs no live leg. Passing `today` through would make the
       * function look for a live day that cannot be inside this range.
       */
      factsForWindow(this.db, providers, actor, b.from, b.to, today, now),
    ]);
    return buildBrief(period, today, days, baseline);
  }

  /**
   * PLAN 07c T3 — THE SAME REPORT, AS A FILE. It is built from the SAME `loadReport` call the screen
   * renders, so the paper, the screen and the spreadsheet cannot disagree about a number — which is
   * the failure a second query would have introduced silently.
   *
   * The `report.exported` event is appended BEFORE the bytes are returned, on the reasoning
   * `kernel/search/audit.ts` already records about writing before the provider call: a log that
   * records only the exports that finished cannot answer for the ones that did not.
   */
  @Get("report.csv")
  async reportCsv(
    @CurrentActor() actor: Actor, @Query() query: unknown, @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const q = parsed(deskQuery, query);
    const now = new Date();
    const date = q.date ?? istDay(now);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`my-day-${date}.csv`));
    if (actor.type !== "user") return toCsv([]);

    const providers = collectDeskProviders(this.registry);
    const { sections } = await loadReport(providers, { db: this.db, actor, reader: actor, date, now });

    /*
     * THE FILE CARRIES THE SAME MARKER THE SCREEN DOES (T2 A4). A CSV outlives the screen it was
     * pulled from — it is mailed, imported and reconciled weeks later — so a mid-shift export that
     * does not say it is mid-shift is the one copy nobody can tell apart from the close.
     */
    const lines: string[][] = [[`report.date`, date], [`report.status`, isProvisional(date, now) ? "provisional" : "final"], []];
    for (const section of sections) {
      lines.push([section.titleKey]);
      lines.push(section.columnKeys);
      lines.push(...section.rows);
      if (section.totals !== undefined) lines.push(section.totals);
      lines.push([]);
    }
    const rows = sections.reduce((n, s) => n + s.rows.length, 0);
    await withTx(this.db, (tx) =>
      appendEvent(tx, reportExported.make({
        actor, payload: { date, scope: "self", sections: sections.length, rows },
      })));
    return toCsv(lines);
  }
}
