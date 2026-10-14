import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { PassForbidden, PassRefusal, passRefusalStatus } from "./errors";
import { PASSES_ISSUE, PASSES_MANAGE, PASSES_PAUSE, PASSES_SCAN } from "./manifest";
import { issuePasses, issueVisitorPass, pausePasses, reissuePass, resumePasses, setPoliceCustody } from "./passes";
import { listPassWards, scanPass, viewAdmissionPasses } from "./read";
import type { Actor, PassRefusalBody } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/** E1.3 (#720) — `PASS_ROUTES`. Thin: each POST is its intent, which re-checks the permission the guard checked. */
function toHttp(e: unknown): never {
  if (e instanceof PassRefusal) {
    const status = passRefusalStatus(e.code);
    const body: PassRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof PassForbidden) throw new HttpException({ statusCode: 403, code: "passes_forbidden", message: e.message }, 403);
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

@Controller("passes")
export class PassesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("wards")
  @RequirePermission(PASSES_SCAN, "hospital", { alsoAdmits: [PASSES_ISSUE] })
  async wards(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { items: await listPassWards(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("admissions/:admissionId")
  @RequirePermission(PASSES_ISSUE, "hospital", { alsoAdmits: [PASSES_PAUSE, PASSES_MANAGE] })
  async admission(@CurrentActor() actor: Actor, @Param("admissionId") admissionId: string): Promise<unknown> {
    try { return await viewAdmissionPasses(this.db, actor, admissionId); } catch (e) { toHttp(e); }
  }

  @Post("issue")
  @RequirePermission(PASSES_ISSUE, "hospital")
  async issue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await issuePasses(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("visitor")
  @RequirePermission(PASSES_ISSUE, "hospital")
  async visitor(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await issueVisitorPass(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("reissue")
  @RequirePermission(PASSES_ISSUE, "hospital")
  async reissue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reissuePass(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("pause")
  @RequirePermission(PASSES_PAUSE, "hospital", { alsoAdmits: [PASSES_MANAGE] })
  async pause(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await pausePasses(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("resume")
  @RequirePermission(PASSES_PAUSE, "hospital", { alsoAdmits: [PASSES_MANAGE] })
  async resume(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await resumePasses(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("custody")
  @RequirePermission(PASSES_MANAGE, "hospital")
  async custody(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await setPoliceCustody(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("scan")
  @RequirePermission(PASSES_SCAN, "hospital")
  async scan(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await scanPass(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
