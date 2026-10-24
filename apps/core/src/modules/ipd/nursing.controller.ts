import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import {
  acceptShiftHandover, acknowledgeEwsAlert, addNursingNote, giveShiftHandover, recordIntakeOutput, recordNursingAssessment, recordVitals,
} from "./nursing";
import { listShiftHandovers, readHandoverDraft, readMyShift, readNurseStation, readNursingChart } from "./nursing-read";
import {
  IPD_ASSESSMENT_RECORD, IPD_EWS_RESPOND, IPD_NURSING_VIEW, IPD_SHIFT_HANDOVER, IPD_VITALS_RECORD,
} from "./permissions";
import type {
  Actor, IpdHandoverDraft, IpdMyShift, IpdNurseStation, IpdNursingChart, IpdRefusalBody, IpdShiftHandoverList,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E4.1 (#733) — the nursing routes (`IPD_NURSING_ROUTES`). Thin: each route is its act function, which re-checks the
 * permission (the copilot and devices reach the same functions without this controller). Refusals answer
 * `IpdRefusalBody`; the nursing acts' own errors answer 404 (not found) or 409 (state).
 */
const NURSING_ERROR_STATUS: Partial<Record<string, number>> = {
  shift_handover_not_found: 404, ews_alert_not_found: 404, shift_handover_not_open: 409, shift_handover_own: 409, ews_alert_closed: 409,
};

function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.bedRule !== undefined) body.bedRule = e.bedRule;
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : NURSING_ERROR_STATUS[e.code] ?? 422;
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

const wardQuery = z.object({ wardId: z.ulid().optional() });
const idParam = z.ulid();
const wardOpts = (q: unknown): { wardId?: string } => {
  const p = wardQuery.parse(q);
  return p.wardId === undefined ? {} : { wardId: p.wardId };
};

@Controller("ipd/nursing")
export class IpdNursingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("station")
  @RequirePermission(IPD_NURSING_VIEW, "hospital")
  async station(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdNurseStation> {
    try { return await readNurseStation(this.db, actor, wardOpts(query)); } catch (e) { toHttp(e); }
  }

  @Get("my-shift")
  @RequirePermission(IPD_NURSING_VIEW, "hospital")
  async myShift(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdMyShift> {
    try { return await readMyShift(this.db, actor, wardOpts(query)); } catch (e) { toHttp(e); }
  }

  @Get("admissions/:id/chart")
  @RequirePermission(IPD_NURSING_VIEW, "hospital")
  async chart(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IpdNursingChart> {
    try { return await readNursingChart(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("admissions/:id/handover-draft")
  @RequirePermission(IPD_SHIFT_HANDOVER, "hospital")
  async handoverDraft(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<IpdHandoverDraft> {
    try { return await readHandoverDraft(this.db, actor, idParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Post("assessment")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async assessment(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordNursingAssessment(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("vitals")
  @RequirePermission(IPD_VITALS_RECORD, "hospital")
  async vitals(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordVitals(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("intake-output")
  @RequirePermission(IPD_VITALS_RECORD, "hospital")
  async intakeOutput(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordIntakeOutput(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("note")
  @RequirePermission(IPD_VITALS_RECORD, "hospital")
  async note(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await addNursingNote(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("shift-handovers")
  @RequirePermission(IPD_SHIFT_HANDOVER, "hospital")
  async shiftHandovers(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdShiftHandoverList> {
    try { return await listShiftHandovers(this.db, actor, wardOpts(query)); } catch (e) { toHttp(e); }
  }

  @Post("shift-handovers/give")
  @RequirePermission(IPD_SHIFT_HANDOVER, "hospital")
  async give(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await giveShiftHandover(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("shift-handovers/accept")
  @RequirePermission(IPD_SHIFT_HANDOVER, "hospital")
  async accept(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await acceptShiftHandover(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("ews/acknowledge")
  @RequirePermission(IPD_EWS_RESPOND, "hospital")
  async acknowledge(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await acknowledgeEwsAlert(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
