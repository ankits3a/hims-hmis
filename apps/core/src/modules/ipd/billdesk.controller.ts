import { Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { readBillDesk, retryFromBillDesk } from "./bill-desk";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_BILLDESK_VIEW, IPD_CHARGES_REVERSE } from "./manifest";
import type { Actor, IpdBillDesk } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdmissionPostResult } from "./charges";

/**
 * E2.3 (#727) — the bill desk over HTTP (`IPD_BILLDESK_ROUTES`): the exceptions list (`ipd.billdesk.view`) and the Retry
 * of a failed or quarantined posting (`ipd.charges.reverse`, the billing manager). Never a doctor (decision 0058).
 */
function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix }, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : 409;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  throw e;
}

@Controller("ipd")
export class IpdBillDeskController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("bill-desk")
  @RequirePermission(IPD_BILLDESK_VIEW, "hospital")
  async desk(@CurrentActor() actor: Actor): Promise<IpdBillDesk> {
    try { return await readBillDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/charges/retry")
  @RequirePermission(IPD_CHARGES_REVERSE, "hospital")
  async retry(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AdmissionPostResult> {
    try { return await retryFromBillDesk(this.db, actor, id); } catch (e) { toHttp(e); }
  }
}
