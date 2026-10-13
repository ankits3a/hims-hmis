import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { IpdBedClassSchema } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_BILL_VIEW, IPD_PAYER_MANAGE } from "./manifest";
import {
  addPayerNonPayable, listPayerNonPayables, printInterimBillSnapshot, retirePayerNonPayable, roomRentCapWarning,
} from "./payer-bill";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E2.2 (#726) — the payer split's routes (`IPD_PAYER_ROUTES`). The split itself rides on the interim bill. Billing and
 * TPA permissions only: no doctor role holds `ipd.bill.view` or `ipd.payer.manage` (decision 0058).
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix }, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "non_payable_not_found" ? 404 : 409;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request failed validation", detail: e.issues }, 400);
  }
  throw e;
}

@Controller("ipd")
export class IpdPayerController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The desk prints the interim bill: the split as printed is kept. */
  @Post("admissions/:id/interim-bill/print")
  @RequirePermission(IPD_BILL_VIEW, "hospital")
  async print(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<unknown> {
    try { return await printInterimBillSnapshot(this.db, actor, id); } catch (e) { toHttp(e); }
  }

  /** The room-rent cap warning for a class (`?class=private`) before an upgrade consent. */
  @Get("admissions/:id/room-rent-warning")
  @RequirePermission(IPD_BILL_VIEW, "hospital")
  async capWarning(@CurrentActor() actor: Actor, @Param("id") id: string, @Query("class") cls: unknown): Promise<unknown> {
    try { return { warning: await roomRentCapWarning(this.db, actor, id, IpdBedClassSchema.parse(cls)) }; } catch (e) { toHttp(e); }
  }

  @Get("payer/non-payables")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async nonPayables(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { items: await listPayerNonPayables(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Post("payer/non-payables")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async addNonPayable(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await addPayerNonPayable(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("payer/non-payables/:id/retire")
  @RequirePermission(IPD_PAYER_MANAGE, "hospital")
  async retireNonPayable(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ retired: true }> {
    try { await retirePayerNonPayable(this.db, actor, id); return { retired: true }; } catch (e) { toHttp(e); }
  }
}
