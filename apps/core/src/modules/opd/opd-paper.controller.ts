import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed, toHttp } from "./opd-masters.controller";
import { rxLineBody } from "./opd-queue.controller";
import {
  confirmPaperConsult, correctPaperPrescription, listPaperConsults, paperCheck, paperCorrectionCheck, paperVisitState,
  reopenPaperConsult, transcribePaper,
} from "./paper-consult";
import type { LineAlerts, PaperConsultRow, TranscribePaperResult } from "./paper-consult";
import type { EncounterRow } from "./encounters";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ CONSULTED ON PAPER — THE ROUTES (owner ruling 2026-10-06) ═══
 *
 * Three seats, one file, because they are three views of one piece of paper:
 *
 *   · the DESK SCRIBE types it (`opd.prescription.transcribe`) — and the service asserts that grant
 *     again, plus `opd.consult.paper` before it closes the visit, because a decorator is one string
 *     and "one `@RequirePermission` silently replaces another" (`walk-in.ts`);
 *   · the DOCTOR looks at it when they choose to (`opd.consult` for the acts; the list itself is on
 *     `opd.visits.read`, which the doctor and the supervisor both hold, and the service decides
 *     which list a caller may have);
 *   · the SUPERVISOR reopens a visit closed on the wrong paper (`opd.queue.transfer`).
 *
 * The slip desk has NO route here: it files a photograph through `POST /patients/:id/documents`
 * exactly as before, and the visit is closed by the capture hook (`opd.module.ts`).
 */
const linesBody = z.object({ lines: z.array(rxLineBody).max(40) });
const transcriptionBody = z.object({
  lines: z.array(rxLineBody).max(40),
  advisedTests: z.array(z.object({
    serviceId: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(300),
    pricePaise: z.number().int().nonnegative(),
  })).max(20).optional(),
  note: z.string().max(2000).nullish(),
});
const correctBody = z.object({
  lines: z.array(rxLineBody).max(40),
  reasons: z.array(z.object({ lineIndex: z.number().int().nonnegative(), reason: z.string().max(500) })).max(40).optional(),
});
const reopenBody = z.object({ reason: z.string().max(500), voidTranscription: z.boolean().optional() });
const listQuery = z.object({ scope: z.enum(["mine", "all"]).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

@Controller("opd/paper")
export class OpdPaperController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @RequirePermission("opd.visits.read", "hospital")
  @Get("consults")
  async consults(
    @CurrentActor() actor: Actor, @Query() query: unknown,
  ): Promise<{ date: string; scope: "mine" | "all"; items: PaperConsultRow[] }> {
    const q = parsed(listQuery, query);
    try {
      return await listPaperConsults(this.db, actor, { scope: q.scope ?? "mine", ...(q.date === undefined ? {} : { date: q.date }) });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.prescription.transcribe", "hospital")
  @Get("visits/:id")
  async visit(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<PaperConsultRow> {
    try {
      return await paperVisitState(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.prescription.transcribe", "hospital")
  @Post("visits/:id/check")
  @HttpCode(200)
  async check(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ lines: LineAlerts[] }> {
    const b = parsed(linesBody, body);
    try {
      return await paperCheck(this.db, actor, id, b.lines);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.prescription.transcribe", "hospital")
  @Post("visits/:id/transcription")
  async transcription(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<TranscribePaperResult> {
    const b = parsed(transcriptionBody, body);
    try {
      return await transcribePaper(this.db, actor, this.cfg, id, {
        lines: b.lines, ...(b.advisedTests === undefined ? {} : { advisedTests: b.advisedTests }), note: b.note ?? null,
      });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/confirm")
  @HttpCode(200)
  async confirm(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<PaperConsultRow> {
    try {
      return await confirmPaperConsult(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/correction-check")
  @HttpCode(200)
  async correctionCheck(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ lines: LineAlerts[] }> {
    const b = parsed(linesBody, body);
    try {
      return await paperCorrectionCheck(this.db, actor, id, b.lines);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/correct")
  @HttpCode(200)
  async correct(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<PaperConsultRow> {
    const b = parsed(correctBody, body);
    try {
      return await correctPaperPrescription(this.db, actor, this.cfg, id, {
        lines: b.lines, ...(b.reasons === undefined ? {} : { reasons: b.reasons }),
      });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.transfer", "hospital")
  @Post("visits/:id/reopen")
  @HttpCode(200)
  async reopen(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(reopenBody, body);
    try {
      return await reopenPaperConsult(this.db, actor, id, {
        reason: b.reason, ...(b.voidTranscription === undefined ? {} : { voidTranscription: b.voidTranscription }),
      });
    } catch (e) {
      toHttp(e);
    }
  }
}
