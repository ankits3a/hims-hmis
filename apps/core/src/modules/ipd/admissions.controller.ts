import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { IPD_APPROVAL_KINDS } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { ApprovalError } from "../../kernel/approvals/types";
import { BillingError, billingHttpStatus } from "../billing";
import {
  askApproval, bedProposalsFor, consultantChoices, listDeskAdmissions, quotesFor, recentAdvice, viewAdmission,
} from "./admission-read";
import {
  admit, backfillDowntime, cancelAdmission, emergencyAdmit, recordConsent, recordStabilised, requestAdmission,
} from "./admissions";
import { printBand, reprintBand } from "./bands";
import { planAdmission, takeDeposit } from "./deposit";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_ADMIT, IPD_ADMIT_REQUEST, IPD_BAND_PRINT, IPD_PAYER_MANAGE } from "./manifest";
import { recordPayerAuth } from "./payer";
import type { Actor, IpdRefusalBody } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E1.2 (#719) — the admission desk's routes (`IPD_ADMIT_ROUTES`). Thin: each POST is its intent function, which
 * re-checks the permission the guard checked; a refusal answers its code with the rule and the fix.
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.bedRule !== undefined) body.bedRule = e.bedRule;
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "admission_workflow_inactive" || e.code === "approval_type_missing" ? 503 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof ApprovalError) throw new HttpException({ statusCode: 422, code: e.code, message: e.message }, 422);
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const approvalBody = z.strictObject({
  kind: z.enum(IPD_APPROVAL_KINDS),
  note: z.string().trim().min(1).max(500),
  amountPaise: z.number().int().positive().optional(),
});

@Controller("ipd/admissions")
export class IpdAdmissionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission(IPD_ADMIT, "hospital")
  async list(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { items: await listDeskAdmissions(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("advice")
  @RequirePermission(IPD_ADMIT_REQUEST, "hospital")
  async advice(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { items: await recentAdvice(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("consultants")
  @RequirePermission(IPD_ADMIT_REQUEST, "hospital")
  async consultants(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { items: await consultantChoices(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get(":id")
  @RequirePermission(IPD_ADMIT, "hospital")
  async one(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await viewAdmission(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  @Get(":id/quotes")
  @RequirePermission(IPD_ADMIT, "hospital")
  async quotes(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return { items: await quotesFor(this.db, actor, id) }; } catch (e) { toHttp(e); }
  }

  @Get(":id/beds")
  @RequirePermission(IPD_ADMIT, "hospital")
  async beds(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return { items: await bedProposalsFor(this.db, actor, id) }; } catch (e) { toHttp(e); }
  }

  @Post(":id/approvals")
  @RequirePermission(IPD_ADMIT, "hospital")
  async approvals(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<unknown> {
    try { return await askApproval(this.db, actor, id, approvalBody.parse(body)); } catch (e) { toHttp(e); }
  }

  @Post("request")
  @RequirePermission(IPD_ADMIT_REQUEST, "hospital")
  async request(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await requestAdmission(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("plan")
  @RequirePermission(IPD_ADMIT, "hospital")
  async plan(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await planAdmission(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("admit")
  @RequirePermission(IPD_ADMIT, "hospital")
  async admit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await admit(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("cancel")
  @RequirePermission(IPD_ADMIT_REQUEST, "hospital")
  async cancel(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cancelAdmission(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("emergency")
  @RequirePermission(IPD_ADMIT, "hospital")
  async emergency(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await emergencyAdmit(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("backfill")
  @RequirePermission(IPD_ADMIT, "hospital")
  async backfill(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await backfillDowntime(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("consent")
  @RequirePermission(IPD_ADMIT, "hospital")
  async consent(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordConsent(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("stabilised")
  @RequirePermission(IPD_ADMIT_REQUEST, "hospital")
  async stabilised(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordStabilised(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("payer-auth")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async payerAuth(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordPayerAuth(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("deposit")
  @RequirePermission(IPD_ADMIT, "hospital")
  async deposit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await takeDeposit(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("band/print")
  @RequirePermission(IPD_BAND_PRINT, "hospital")
  async print(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await printBand(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("band/reprint")
  @RequirePermission(IPD_BAND_PRINT, "hospital")
  async reprint(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reprintBand(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
