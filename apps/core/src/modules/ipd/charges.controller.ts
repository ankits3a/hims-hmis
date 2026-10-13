import { Body, Controller, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { reverseChargeLine } from "./charges";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_CHARGES_REVERSE } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E2.1 review (#756 item 10) — the running bill's one act over HTTP: reverse a wrong line (a new negative line with a
 * reason, never an edit). `ipd.charges.reverse` (the billing manager). Visit posting is not a route: the rounds lane
 * calls `postConsultantVisit` inside its own act.
 */
const reverseBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix }, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "charge_line_not_found" ? 404 : e.code === "reversal_reason_required" ? 400 : 409;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

@Controller("ipd/charge-lines")
export class IpdChargesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post(":id/reverse")
  @RequirePermission(IPD_CHARGES_REVERSE, "hospital")
  async reverse(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ reversalLineId: string }> {
    try {
      const { reason } = reverseBody.parse(body);
      return await reverseChargeLine(this.db, actor, { chargeLineId: id, reason });
    } catch (e) { toHttp(e); }
  }
}
