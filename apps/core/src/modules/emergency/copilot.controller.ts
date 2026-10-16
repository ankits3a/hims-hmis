import { Controller, Get, HttpCode, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { ER_DRAFT_KINDS } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { buildErDraft } from "./copilot-drafts";
import { readEsiProposal } from "./copilot-esi";
import { erModelFrom } from "./copilot-model";
import { readSinceArrival } from "./copilot-since";
import { readErWaitingDisplay } from "./copilot-waiting";
import { ErError, ErRefusal, erRefusalStatus } from "./errors";
import { ER_BOARD_WALL, ER_CARE, ER_DISPOSITION, ER_MLC, ER_TRIAGE } from "./names";
import type { Actor, ErDraft, ErEsiProposal, ErRefusalBody, ErSinceArrival, ErWaitingDisplay } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { ErModel } from "./copilot-model";

/**
 * ER lane 9 (#816) — the ER copilot routes (`ER_COPILOT_ROUTES`). Thin: each route is its function, which re-checks the
 * permission. None writes a record: the proposal, "since arrival" and the waiting display are reads; a draft is built on
 * a tap and handed back stamped "Draft" — the record exists only when a doctor signs it through the act that owns it.
 * The model is the staff copilot's (`COPILOT_*`); with none configured every draft is its template.
 */
function toHttp(e: unknown): never {
  if (e instanceof ErRefusal) {
    const status = erRefusalStatus(e.code);
    const body: ErRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof ErError) {
    const status = e.code === "er_forbidden" ? 403 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const idParam = z.string().trim().min(1).max(64);
const kindParam = z.enum(ER_DRAFT_KINDS);

@Controller("er/copilot")
export class EmergencyCopilotController {
  private readonly model: ErModel;

  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) cfg: AppConfig) {
    this.model = erModelFrom(cfg);
  }

  @Get("esi/:episodeId")
  @RequirePermission(ER_TRIAGE, "hospital")
  async esi(@CurrentActor() actor: Actor, @Param("episodeId") id: string): Promise<ErEsiProposal> {
    try { return await readEsiProposal(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("since/:episodeId")
  @RequirePermission(ER_CARE, "hospital")
  async since(@CurrentActor() actor: Actor, @Param("episodeId") id: string): Promise<ErSinceArrival> {
    try { return await readSinceArrival(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  /** A draft, on a tap. The MLC narrative needs `er.mlc`; the summary and the referral `er.disposition` (each re-checked). */
  @Post("drafts/:episodeId/:kind")
  @HttpCode(200)
  @RequirePermission(ER_DISPOSITION, "hospital", { alsoAdmits: [ER_MLC] })
  async draft(@CurrentActor() actor: Actor, @Param("episodeId") id: string, @Param("kind") kind: string): Promise<ErDraft> {
    try { return await buildErDraft(this.db, actor, idParam.parse(id), kindParam.parse(kind), { model: this.model }); } catch (e) { toHttp(e); }
  }

  @Get("waiting")
  @RequirePermission(ER_BOARD_WALL, "hospital")
  async waiting(@CurrentActor() actor: Actor): Promise<ErWaitingDisplay> {
    try { return await readErWaitingDisplay(this.db, actor); } catch (e) { toHttp(e); }
  }
}
