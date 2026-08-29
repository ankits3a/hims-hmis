import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../tokens";
import { IST_UTC_OFFSET_MINUTES } from "../approvals/cumulative";
import { CurrentActor } from "../auth/decorators";
import { collectDeskProviders, loadDesk, loadReport } from "./registry";
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
 * IST calendar day, the grain every desk figure is cut on.
 *
 * It reuses `IST_UTC_OFFSET_MINUTES` rather than writing the offset out again, because
 * `test/ist-clock-parity.test.ts` pins the census of files that DO write it by hand and reddens on a
 * new one. That guard caught this file on its first verify — which is ledger §2.105 working exactly
 * as intended: one expression, and a test that goes red when a copy appears.
 */
function istDay(at: Date): string {
  return new Date(at.getTime() + IST_UTC_OFFSET_MINUTES * 60 * 1000).toISOString().slice(0, 10);
}

const deskQuery = z.object({ date: z.string().length(10).optional() });

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
    const q = deskQuery.parse(query);
    const now = new Date();
    const date = q.date ?? istDay(now);
    /**
     * An AGENT gets an empty desk rather than an error, matching `/auth/me`'s own reasoning: agents
     * hold no permissions at all, so "what is on this actor's desk" has the answer `nothing`, and
     * returning it is more honest than a 403 on a route whose job is to describe the caller.
     */
    if (actor.type !== "user") return { date, cards: [] };
    const providers = collectDeskProviders(this.registry);
    return { date, ...(await loadDesk(providers, { db: this.db, actor, date, now })) };
  }

  /**
   * PLAN 07c T2 — THE PERSON'S OWN DAY. There is NO `userId` parameter, and that is the whole of
   * the authority model: you cannot ask for somebody else's, because there is nowhere to put their
   * id. Self-scoping is structural rather than a check a later edit can drop.
   */
  @Get("report")
  async report(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ date: string; sections: ReportSection[] }> {
    const q = deskQuery.parse(query);
    const now = new Date();
    const date = q.date ?? istDay(now);
    if (actor.type !== "user") return { date, sections: [] };
    const providers = collectDeskProviders(this.registry);
    return { date, ...(await loadReport(providers, { db: this.db, actor, date, now })) };
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
    const q = deskQuery.parse(query);
    const now = new Date();
    const date = q.date ?? istDay(now);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", contentDisposition(`my-day-${date}.csv`));
    if (actor.type !== "user") return toCsv([]);

    const providers = collectDeskProviders(this.registry);
    const { sections } = await loadReport(providers, { db: this.db, actor, date, now });

    const lines: string[][] = [];
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
