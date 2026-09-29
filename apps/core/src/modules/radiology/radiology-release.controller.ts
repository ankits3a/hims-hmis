import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { istDayString } from "../../kernel/approvals/cumulative";
import { IMAGING_ACTED_OUTCOMES, IMAGING_COLLECTOR_ID_TYPES, IMAGING_COLLECTOR_KINDS, IMAGING_MEDIA_KINDS } from "../../kernel/db/schema/radiology";
import { doctorReadBack, doctorResultsInbox, markActedUpon } from "./closed-loop";
import { northStar } from "./north-star";
import { handOverReport, markMediaPrinted, releaseRegister, requestMedia } from "./release";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS9 — **RELEASE AND THE CLOSED LOOP, OVER HTTP.**
 *
 * The doctor's side, on `radiology.reports.read` (the doctor's grant, DD16) plus the treating-doctor
 * check inside each act (`not_treating_doctor` for anybody else):
 *   · `GET  /radiology/results` — the logged-in doctor's imaging results inbox;
 *   · `POST /radiology/reports/:id/acted` — what the report changed (outcome + one line);
 *   · `POST /radiology/reports/:id/read-back` — the doctor's read-back of a critical, on the same
 *     `acknowledgeCritical` the reading room's route calls.
 *
 * The HOD's measure, on `radiology.reports.sign` — the grant only the reporting radiologist holds
 * (the HOD is a radiologist; the desk, the technologist and the referring doctor do not hold it):
 *   · `GET  /radiology/north-star?from&to` — order → acted, per modality and source (IST days,
 *     inclusive; default the last 30).
 *
 * The desk's release register, on `radiology.schedule` — the imaging desk's own grant:
 *   · `GET  /radiology/release`, `POST /radiology/studies/:id/media`,
 *     `POST /radiology/media/:id/printed`, `POST /radiology/reports/:id/handover`.
 */
const actedBody = z.object({
  outcome: z.enum(IMAGING_ACTED_OUTCOMES),
  note: z.string().max(500),
}).strict();
const readBackBody = z.object({ readBack: z.string().max(1000).nullable().optional() }).strict();
const mediaBody = z.object({ kind: z.enum(IMAGING_MEDIA_KINDS), quantity: z.number().int().min(1).max(20).optional() }).strict();
const handoverBody = z.object({
  collectorKind: z.enum(IMAGING_COLLECTOR_KINDS),
  collectorName: z.string().max(120).nullable().optional(),
  collectorRelation: z.string().max(60).nullable().optional(),
  collectorIdType: z.enum(IMAGING_COLLECTOR_ID_TYPES).nullable().optional(),
  collectorIdLast4: z.string().max(4).nullable().optional(),
  mediaRequestIds: z.array(idSchema).max(20).optional(),
  note: z.string().max(300).nullable().optional(),
}).strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

@Controller("radiology")
export class RadiologyReleaseController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("results")
  @RequirePermission("radiology.reports.read", "hospital")
  async results(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await doctorResultsInbox(this.db, actor) };
    } catch (e) { toHttp(e); }
  }

  @Post("reports/:reportId/acted")
  @RequirePermission("radiology.reports.read", "hospital")
  async acted(@CurrentActor() actor: Actor, @Param("reportId") reportId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, reportId);
    const input = parsed(actedBody, body);
    try {
      return await withTx(this.db, (tx) => markActedUpon(tx, actor, { reportId, outcome: input.outcome, note: input.note }));
    } catch (e) { toHttp(e); }
  }

  @Post("reports/:reportId/read-back")
  @RequirePermission("radiology.reports.read", "hospital")
  async readBack(@CurrentActor() actor: Actor, @Param("reportId") reportId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, reportId);
    const input = parsed(readBackBody, body);
    try {
      return await withTx(this.db, (tx) => doctorReadBack(tx, actor, { reportId, readBack: input.readBack ?? null }));
    } catch (e) { toHttp(e); }
  }

  @Get("north-star")
  @RequirePermission("radiology.reports.sign", "hospital")
  async northStar(@Query("from") from?: string, @Query("to") to?: string): Promise<unknown> {
    const today = istDayString(new Date());
    const monthAgo = istDayString(new Date(Date.now() - 29 * 86_400_000));
    try {
      return await northStar(this.db, {
        from: from === undefined ? monthAgo : parsed(day, from),
        to: to === undefined ? today : parsed(day, to),
      });
    } catch (e) { toHttp(e); }
  }

  @Get("release")
  @RequirePermission("radiology.schedule", "hospital")
  async release(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await releaseRegister(this.db, actor) };
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/media")
  @RequirePermission("radiology.schedule", "hospital")
  async media(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(mediaBody, body);
    try {
      return await withTx(this.db, (tx) => requestMedia(tx, actor, { studyId, kind: input.kind, quantity: input.quantity }));
    } catch (e) { toHttp(e); }
  }

  @Post("media/:requestId/printed")
  @RequirePermission("radiology.schedule", "hospital")
  async printed(@CurrentActor() actor: Actor, @Param("requestId") requestId: string): Promise<unknown> {
    parsed(idSchema, requestId);
    try {
      return await withTx(this.db, (tx) => markMediaPrinted(tx, actor, { requestId }));
    } catch (e) { toHttp(e); }
  }

  @Post("reports/:reportId/handover")
  @RequirePermission("radiology.schedule", "hospital")
  async handover(@CurrentActor() actor: Actor, @Param("reportId") reportId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, reportId);
    const input = parsed(handoverBody, body);
    try {
      return await withTx(this.db, (tx) => handOverReport(tx, actor, { reportId, ...input }));
    } catch (e) { toHttp(e); }
  }
}
