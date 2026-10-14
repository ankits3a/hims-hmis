import { Controller, Get, HttpCode, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { buildDischargeDraft, buildSbarDraft, polishSinceYesterday, readSinceYesterday } from "./copilot";
import { ipdModelFrom } from "./copilot-model";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_DISCHARGE_DECLARE, IPD_ROUND_SIGN, IPD_SHIFT_HANDOVER } from "./permissions";
import type { Actor, IpdDischargeDraft, IpdHandoverDraft, IpdRefusalBody, IpdSinceYesterday } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { IpdModel } from "./copilot-model";

/**
 * E5.3 (#740), E5.4 (#741) — the IPD copilot routes (`IPD_COPILOT_ROUTES`). Thin: each route is its function, which
 * re-checks the permission. The model is the staff copilot's own (`COPILOT_*` config) behind `copilot-model.ts`; with
 * none configured every route answers its template. A `POST` here builds and keeps a DRAFT — never a record: the
 * handover and the summary exist only when a named person gives or signs them through their own acts. No answer carries
 * money (decision 0058).
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code.endsWith("_not_found") ? 404 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const admissionParam = z.ulid();

@Controller("ipd")
export class IpdCopilotController {
  private readonly model: IpdModel;

  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) cfg: AppConfig) {
    this.model = ipdModelFrom(cfg);
  }

  /** The rounds page's first block: deterministic, no model call, no write. */
  @Get("rounds/:admissionId/since")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async since(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdSinceYesterday> {
    try { return await readSinceYesterday(this.db, actor, admissionParam.parse(id), { model: this.model }); } catch (e) { toHttp(e); }
  }

  /** Asked by the page AFTER it has drawn the lines: a model's rewording inside 1 s, or the same plain timeline. */
  @Post("rounds/:admissionId/since/polish")
  @HttpCode(200)
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async polish(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdSinceYesterday> {
    try { return await polishSinceYesterday(this.db, actor, admissionParam.parse(id), { model: this.model }); } catch (e) { toHttp(e); }
  }

  @Post("nursing/admissions/:id/handover-draft")
  @HttpCode(200)
  @RequirePermission(IPD_SHIFT_HANDOVER, "hospital")
  async sbarDraft(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IpdHandoverDraft> {
    try { return await buildSbarDraft(this.db, actor, admissionParam.parse(id), { model: this.model }); } catch (e) { toHttp(e); }
  }

  @Post("discharge/:admissionId/summary/draft")
  @HttpCode(200)
  @RequirePermission(IPD_DISCHARGE_DECLARE, "hospital")
  async dischargeDraft(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdDischargeDraft> {
    try { return await buildDischargeDraft(this.db, actor, admissionParam.parse(id), { model: this.model }); } catch (e) { toHttp(e); }
  }
}
