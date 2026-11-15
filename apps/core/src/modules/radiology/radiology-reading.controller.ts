import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { imagingAssignBody, imagingClaimBody } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { readingContext, readingWorklist, reportPrintView } from "./reading";
import { assignReader, claimReading } from "./reading-claim";
import { criticalCallBoard } from "./critical-ladder";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8a — **THE READING ROOM'S READS.** The list and the study in hand are behind
 * `radiology.reports.write` (the reader this room is for); the print is behind the report's own
 * `radiology.reports.read`. The report's writes go through the report routes; #1081 adds the room's
 * own two: the claim (the reader's) and the assignment (a consultant's `radiology.reports.amend`).
 */
@Controller("radiology")
export class RadiologyReadingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** #1081 — `?view=all` is the whole list; anything else is the reader's own ("my list"). */
  @Get("reading/worklist")
  @RequirePermission("radiology.reports.write", "hospital")
  async worklist(@CurrentActor() actor: Actor, @Query("view") view?: string): Promise<unknown> {
    try {
      return { rows: await readingWorklist(this.db, actor, new Date(), { view: view === "all" ? "all" : "mine" }) };
    } catch (e) { toHttp(e); }
  }

  /** #1081 — opening a study claims it ("Dr X is reading"); `takeOver` takes another reader's live claim. */
  @Post("reading/studies/:studyId/claim")
  @RequirePermission("radiology.reports.write", "hospital")
  async claim(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(imagingClaimBody, body ?? {});
    try {
      return await withTx(this.db, (tx) => claimReading(tx, actor, { studyId: parsed(idSchema, studyId), takeOver: input.takeOver }));
    } catch (e) { toHttp(e); }
  }

  /** #1081 — a consultant gives the study to a named reader (no new permission: the consultant's amend grant). */
  @Post("reading/studies/:studyId/assign")
  @RequirePermission("radiology.reports.amend", "hospital")
  async assign(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(imagingAssignBody, body);
    try {
      return await withTx(this.db, (tx) => assignReader(tx, actor, { studyId: parsed(idSchema, studyId), readerId: input.readerId }));
    } catch (e) { toHttp(e); }
  }

  @Get("reading/studies/:studyId")
  @RequirePermission("radiology.reports.write", "hospital")
  async study(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { study: await readingContext(this.db, actor, parsed(idSchema, studyId)) };
    } catch (e) { toHttp(e); }
  }

  /**
   * 18-S RS8b — the Critical calls view: open calls with their ladder, and the last 48 hours'
   * acknowledged log. `radiology.criticals.ack` — the people who make and close the calls.
   */
  @Get("reading/criticals")
  @RequirePermission("radiology.criticals.ack", "hospital")
  async criticals(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return await criticalCallBoard(this.db, actor);
    } catch (e) { toHttp(e); }
  }

  /** Ruling 4 — the signed report as it prints, with the signer block. A draft never prints (null). */
  @Get("reports/:reportId/print")
  @RequirePermission("radiology.reports.read", "hospital")
  async print(@CurrentActor() actor: Actor, @Param("reportId") reportId: string): Promise<unknown> {
    try {
      return { report: await reportPrintView(this.db, actor, parsed(idSchema, reportId)) };
    } catch (e) { toHttp(e); }
  }
}
