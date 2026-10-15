import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_PAYER_MANAGE, IPD_PAYER_TERMS } from "./permissions";
import {
  answerTpaQuery, attachTpaDocument, recordClaimRejection, recordClaimSettlement, recordTpaQuery, removeSchemePackage, selectSchemePackage,
  submitClaim,
} from "./tpa";
import { importSchemePackages, searchSchemePackages } from "./tpa-packages";
import { readTpaBoard, readTpaPanel } from "./tpa-read";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #604 (decision 0075) — the TPA desk's routes (`IPD_TPA_ROUTES`). `ipd.payer.manage` for the desk, `ipd.payer.terms` for
 * money in (a settlement) and the package master. No doctor role holds either (decision 0058). Each route only parses
 * and calls the intent: the rules live in `tpa.ts`.
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix, detail: e.detail }, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "package_import_invalid" ? 400 : 409;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const obj = (b: unknown): Record<string, unknown> => (b !== null && typeof b === "object" ? (b as Record<string, unknown>) : {});
const SchemeSchema = z.enum(["pmjay", "state_scheme"]);

@Controller("ipd")
export class IpdTpaController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("tpa/board")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async board(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await readTpaBoard(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("admissions/:id/tpa")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async panel(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await readTpaPanel(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Get("tpa/packages")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async packages(@CurrentActor() actor: Actor, @Query("scheme") scheme: unknown, @Query("q") q: unknown): Promise<unknown> {
    try {
      return { items: await searchSchemePackages(this.db, actor, { scheme: SchemeSchema.parse(scheme), ...(typeof q === "string" ? { q } : {}) }) };
    } catch (e) { toHttp(e); }
  }

  @Post("tpa/packages/import")
  @RequirePermission(IPD_PAYER_TERMS, "hospital")
  async importPackages(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await importSchemePackages(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("tpa/queries")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async recordQuery(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordTpaQuery(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("tpa/queries/:id/answer")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async answerQuery(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    try { return await answerTpaQuery(this.db, actor, { ...obj(body), queryId: id }); } catch (e) { toHttp(e); }
  }

  @Post("tpa/documents")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async attach(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await attachTpaDocument(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/packages")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async selectPackage(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    try { return await selectSchemePackage(this.db, actor, { ...obj(body), admissionId: id }); } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/packages/:selectionId/remove")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async removePackage(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Param("selectionId") selectionId: string, @Body() body: unknown,
  ): Promise<unknown> {
    try { return await removeSchemePackage(this.db, actor, { ...obj(body), admissionId: id, selectionId }); } catch (e) { toHttp(e); }
  }

  @Post("tpa/claims/:id/submit")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async submit(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    try { return await submitClaim(this.db, actor, { ...obj(body), claimId: id }); } catch (e) { toHttp(e); }
  }

  @Post("tpa/claims/:id/settle")
  @RequirePermission(IPD_PAYER_TERMS, "hospital")
  async settle(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    try { return await recordClaimSettlement(this.db, actor, { ...obj(body), claimId: id }); } catch (e) { toHttp(e); }
  }

  @Post("tpa/claims/:id/reject")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async reject(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    try { return await recordClaimRejection(this.db, actor, { ...obj(body), claimId: id }); } catch (e) { toHttp(e); }
  }
}
