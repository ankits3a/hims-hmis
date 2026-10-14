import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { IpdAttendantConsentSchema } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import {
  dailyTotalsSendingOf, readAttendantMessages, recordAttendantConsent, stopAttendantMessages,
} from "./attendant-messages";
import { readBillDesk, retryFromBillDesk } from "./bill-desk";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import { IPD_BILLDESK_VIEW, IPD_BILL_VIEW, IPD_CHARGES_REVERSE, IPD_FAMILY_ISSUE } from "./manifest";
import type { Actor, IpdAttendantMessages, IpdBillDesk, IpdDailyTotalsSending } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
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
  /** #761 — whether the daily totals can be sent, from this process's config (the worker reads the same keys). */
  private readonly sending: IpdDailyTotalsSending;
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) cfg: AppConfig) {
    this.sending = dailyTotalsSendingOf(cfg.ipdDailyTotals);
  }

  @Get("bill-desk")
  @RequirePermission(IPD_BILLDESK_VIEW, "hospital")
  async desk(@CurrentActor() actor: Actor): Promise<IpdBillDesk> {
    try { return await readBillDesk(this.db, actor, new Date(), this.sending); } catch (e) { toHttp(e); }
  }

  /** #761 — the admission's daily-totals card: attendant (masked), consent, stop, last day's line. */
  @Get("admissions/:id/attendant-messages")
  @RequirePermission(IPD_BILL_VIEW, "hospital")
  async attendantMessages(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IpdAttendantMessages> {
    try { return await readAttendantMessages(this.db, actor, id, this.sending); } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/attendant-messages/consent")
  @RequirePermission(IPD_FAMILY_ISSUE, "hospital")
  async attendantConsent(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<IpdAttendantMessages> {
    const parsed = IpdAttendantConsentSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ statusCode: 400, code: "invalid_body", message: "invalid body", issues: parsed.error.issues }, 400);
    try {
      await recordAttendantConsent(this.db, actor, id, parsed.data);
      return await readAttendantMessages(this.db, actor, id, this.sending);
    } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/attendant-messages/stop")
  @RequirePermission(IPD_FAMILY_ISSUE, "hospital")
  async attendantStop(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IpdAttendantMessages> {
    try {
      await stopAttendantMessages(this.db, actor, id);
      return await readAttendantMessages(this.db, actor, id, this.sending);
    } catch (e) { toHttp(e); }
  }

  @Post("admissions/:id/charges/retry")
  @RequirePermission(IPD_CHARGES_REVERSE, "hospital")
  async retry(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<AdmissionPostResult> {
    try { return await retryFromBillDesk(this.db, actor, id); } catch (e) { toHttp(e); }
  }
}
