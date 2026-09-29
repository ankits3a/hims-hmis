import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import {
  PACS_INTERFACE, PACS_RECONCILE, attachUnmatched, ingestArrival, ingestDoseSr, pacsInbox, parseDoseSr,
  parseOrthancStudy, rejectUnmatched,
} from "./pacs";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS12 — the archive's two doors in, and the inbox.
 *
 * `POST /radiology/pacs/arrivals` and `POST /radiology/pacs/dose-reports` are the BRIDGE's
 * (`radiology.pacs.interface`, held by `modality_bridge` only): the body is what Orthanc returned,
 * forwarded as-is, and parsing it is this server's job so the bridge stays a shell script. Both are
 * idempotent — a re-sent notice answers the same outcome and writes nothing new — and both answer
 * 200 rather than 201 because a repeat creates nothing.
 *
 * `GET /radiology/pacs/inbox`, `POST …/unmatched/:id/attach|reject` are the reconciler's
 * (`radiology.pacs.reconcile`: technologist and radiologist).
 */
const attachBody = z.object({ accessionNo: z.string().trim().min(1).max(32), reason: z.string().max(500) }).strict();
const rejectBody = z.object({ reason: z.string().max(500) }).strict();

@Controller("radiology/pacs")
export class RadiologyPacsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post("arrivals")
  @HttpCode(200)
  @RequirePermission(PACS_INTERFACE, "hospital")
  async arrival(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try {
      const notice = parseOrthancStudy(body);
      return await withTx(this.db, (tx) => ingestArrival(tx, actor, notice));
    } catch (e) { toHttp(e); }
  }

  @Post("dose-reports")
  @HttpCode(200)
  @RequirePermission(PACS_INTERFACE, "hospital")
  async doseReport(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try {
      const notice = parseDoseSr(body);
      return await withTx(this.db, (tx) => ingestDoseSr(tx, actor, notice));
    } catch (e) { toHttp(e); }
  }

  @Get("inbox")
  @RequirePermission(PACS_RECONCILE, "hospital")
  async inbox(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return await pacsInbox(this.db, actor);
    } catch (e) { toHttp(e); }
  }

  @Post("unmatched/:unmatchedId/attach")
  @RequirePermission(PACS_RECONCILE, "hospital")
  async attach(@CurrentActor() actor: Actor, @Param("unmatchedId") raw: string, @Body() body: unknown): Promise<unknown> {
    const unmatchedId = parsed(idSchema, raw);
    const input = parsed(attachBody, body);
    try {
      return await withTx(this.db, (tx) => attachUnmatched(tx, actor, { unmatchedId, ...input }));
    } catch (e) { toHttp(e); }
  }

  @Post("unmatched/:unmatchedId/reject")
  @RequirePermission(PACS_RECONCILE, "hospital")
  async reject(@CurrentActor() actor: Actor, @Param("unmatchedId") raw: string, @Body() body: unknown): Promise<unknown> {
    const unmatchedId = parsed(idSchema, raw);
    const input = parsed(rejectBody, body);
    try {
      return await withTx(this.db, (tx) => rejectUnmatched(tx, actor, { unmatchedId, ...input }));
    } catch (e) { toHttp(e); }
  }
}
