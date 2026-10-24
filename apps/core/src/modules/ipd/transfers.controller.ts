import { Body, Controller, Get, HttpException, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_ADMIT, IPD_TRANSFER_ACCEPT, IPD_TRANSFER_START } from "./manifest";
import { acceptHandover, cancelTransfer, changeClass, listHandovers, startTransfer, swapBeds, transferOptions } from "./transfers";
import type { Actor, IpdHandoverList, IpdRefusalBody, IpdTransferOptions } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E3.1 (#729) — the transfer routes (`IPD_TRANSFER_ROUTES`). Thin: each route is its intent function, which re-checks
 * the permission (the copilot reaches the same functions without this controller). Refusals answer `IpdRefusalBody`.
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
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "admission_workflow_inactive" ? 503 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const handoverQuery = z.object({ wardId: z.ulid().optional() });
const optionsQuery = z.object({ admissionId: z.ulid() });

@Controller("ipd/transfers")
export class IpdTransfersController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("handovers")
  @RequirePermission(IPD_TRANSFER_ACCEPT, "hospital")
  async handovers(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdHandoverList> {
    try {
      const q = handoverQuery.parse(query);
      return await listHandovers(this.db, actor, q.wardId === undefined ? {} : { wardId: q.wardId });
    } catch (e) { toHttp(e); }
  }

  @Get("options")
  @RequirePermission(IPD_TRANSFER_START, "hospital")
  async options(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdTransferOptions> {
    try { return await transferOptions(this.db, actor, optionsQuery.parse(query).admissionId); } catch (e) { toHttp(e); }
  }

  @Post("start")
  @RequirePermission(IPD_TRANSFER_START, "hospital")
  async start(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await startTransfer(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("accept")
  @RequirePermission(IPD_TRANSFER_ACCEPT, "hospital")
  async accept(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await acceptHandover(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  /** The sender calls it off, or the receiving ward declines: either transfer string admits (the intent re-checks). */
  @Post("cancel")
  @RequirePermission(IPD_TRANSFER_START, "hospital", { alsoAdmits: [IPD_TRANSFER_ACCEPT] })
  async cancel(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cancelTransfer(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("swap")
  @RequirePermission(IPD_TRANSFER_START, "hospital")
  async swap(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await swapBeds(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("change-class")
  @RequirePermission(IPD_ADMIT, "hospital")
  async changeClass(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await changeClass(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
