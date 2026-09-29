import { Controller, Get, Inject, Param } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { readingContext, readingWorklist, reportPrintView } from "./reading";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8a — **THE READING ROOM'S READS.** The list and the study in hand are behind
 * `radiology.reports.write` (the reader this room is for); the print is behind the report's own
 * `radiology.reports.read`. Every write the room makes goes through the existing report routes.
 */
@Controller("radiology")
export class RadiologyReadingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("reading/worklist")
  @RequirePermission("radiology.reports.write", "hospital")
  async worklist(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await readingWorklist(this.db, actor) };
    } catch (e) { toHttp(e); }
  }

  @Get("reading/studies/:studyId")
  @RequirePermission("radiology.reports.write", "hospital")
  async study(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { study: await readingContext(this.db, actor, parsed(idSchema, studyId)) };
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
