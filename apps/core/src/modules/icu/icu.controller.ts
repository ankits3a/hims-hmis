import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { acknowledgeAlarm, confirmLimitOnMonitor, setAlarmLimit } from "./alarms";
import { completeBundle, insertLine, removeLine, startSepsisBundle } from "./bundles";
import { correctValue, enterManualHour, prefillHour, readChart, signHour } from "./chart";
import { linkDevice, unlinkDevice } from "./devices";
import { IcuError, icuHttpStatus } from "./errors";
import { logFamilyUpdate, logVisit } from "./family";
import { ingestBatch, mapCode, mapSlot, registerGateway } from "./feed";
import { ICU_CARE, ICU_DECIDE, ICU_MANAGE, ICU_REQUEST, ICU_VIEW } from "./permissions";
import { listHalls, readBed, readIncharge, readMyBeds, readNight, readStation, readTrends } from "./reads";
import { decideIcuRequest, listIcuRequests, requestIcu } from "./requests";
import type {
  Actor, IcuBedView, IcuChartHourView, IcuChartView, IcuFeedResult, IcuHallSummary, IcuInchargeView, IcuMyBedsView, IcuNightView,
  IcuRequestView, IcuStationView, IcuTrendView,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984) — THE ICU DOORS. The door checks the permission; the intent checks the state and re-checks the
 * permission. A refusal answers `{ code, message, fix }`. The gateway's feed door carries NO permission decorator: it is
 * an AGENT call (`x-agent-key`), and agents hold no permissions — the intent refuses any caller that is not the hall
 * gateway's own bound agent (the print relay's shape).
 */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IcuError) {
      const status = icuHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix, details: e.details }, status);
    }
    throw e;
  }
}

@Controller("icu")
export class IcuController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /* ═══ the gateway (agent) ═══ */
  @Post("feed/:gatewayId/batches")
  async feed(@CurrentActor() actor: Actor, @Param("gatewayId") gatewayId: string, @Body() body: unknown): Promise<IcuFeedResult> {
    return refusing(() => ingestBatch(this.db, actor, gatewayId, body));
  }

  /* ═══ requests (D1) ═══ */
  @Get("requests")
  @RequirePermission(ICU_VIEW, "hospital")
  async requests(@CurrentActor() actor: Actor): Promise<IcuRequestView[]> { return refusing(() => listIcuRequests(this.db, actor)); }

  @Post("requests")
  @RequirePermission(ICU_REQUEST, "hospital")
  async raise(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IcuRequestView> { return refusing(() => requestIcu(this.db, actor, body)); }

  @Post("requests/:requestId/decision")
  @RequirePermission(ICU_DECIDE, "hospital")
  async decide(@CurrentActor() actor: Actor, @Param("requestId") requestId: string, @Body() body: unknown): Promise<IcuRequestView> {
    return refusing(() => decideIcuRequest(this.db, actor, { ...(body as object), requestId }));
  }

  /* ═══ devices (D2) ═══ */
  @Post("devices/link")
  @RequirePermission(ICU_CARE, "hospital")
  async link(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => linkDevice(this.db, actor, body)); }

  @Post("devices/unlink")
  @RequirePermission(ICU_CARE, "hospital")
  async unlink(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => unlinkDevice(this.db, actor, body)); }

  /* ═══ screens ═══ */
  @Get("halls")
  @RequirePermission(ICU_VIEW, "hospital")
  async halls(@CurrentActor() actor: Actor): Promise<IcuHallSummary[]> { return refusing(() => listHalls(this.db, actor)); }

  @Get("station/:hallId")
  @RequirePermission(ICU_VIEW, "hospital")
  async station(@CurrentActor() actor: Actor, @Param("hallId") hallId: string): Promise<IcuStationView> { return refusing(() => readStation(this.db, actor, hallId)); }

  @Get("beds/:admissionId")
  @RequirePermission(ICU_VIEW, "hospital")
  async bed(@CurrentActor() actor: Actor, @Param("admissionId") admissionId: string): Promise<IcuBedView> { return refusing(() => readBed(this.db, actor, admissionId)); }

  @Get("trends/:admissionId")
  @RequirePermission(ICU_VIEW, "hospital")
  async trends(@CurrentActor() actor: Actor, @Param("admissionId") admissionId: string, @Query("hours") hours?: string): Promise<IcuTrendView> {
    const h = Number(hours ?? "24");
    return refusing(() => readTrends(this.db, actor, admissionId, new Date(), Number.isFinite(h) ? h : 24));
  }

  @Get("my-beds")
  @RequirePermission(ICU_CARE, "hospital")
  async myBeds(@CurrentActor() actor: Actor): Promise<IcuMyBedsView> { return refusing(() => readMyBeds(this.db, actor)); }

  @Get("night")
  @RequirePermission(ICU_DECIDE, "hospital")
  async night(@CurrentActor() actor: Actor): Promise<IcuNightView> { return refusing(() => readNight(this.db, actor)); }

  @Get("incharge")
  @RequirePermission(ICU_MANAGE, "hospital")
  async incharge(@CurrentActor() actor: Actor): Promise<IcuInchargeView> { return refusing(() => readIncharge(this.db, actor)); }

  /* ═══ the hourly chart (D4, D7) ═══ */
  @Get("chart/:admissionId")
  @RequirePermission(ICU_VIEW, "hospital")
  async chart(@CurrentActor() actor: Actor, @Param("admissionId") admissionId: string): Promise<IcuChartView> { return refusing(() => readChart(this.db, actor, admissionId)); }

  @Post("chart/prefill")
  @RequirePermission(ICU_CARE, "hospital")
  async prefill(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IcuChartHourView> { return refusing(() => prefillHour(this.db, actor, body)); }

  @Post("chart/sign")
  @RequirePermission(ICU_CARE, "hospital")
  async sign(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IcuChartHourView> { return refusing(() => signHour(this.db, actor, body)); }

  @Post("chart/correct")
  @RequirePermission(ICU_CARE, "hospital")
  async correct(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IcuChartHourView> { return refusing(() => correctValue(this.db, actor, body)); }

  @Post("chart/manual")
  @RequirePermission(ICU_CARE, "hospital")
  async manual(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IcuChartHourView> { return refusing(() => enterManualHour(this.db, actor, body)); }

  /* ═══ alarms and limits (D5, D6) ═══ */
  @Post("limits")
  @RequirePermission(ICU_DECIDE, "hospital")
  async limit(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => setAlarmLimit(this.db, actor, body)); }

  @Post("limits/:limitId/on-monitor")
  @RequirePermission(ICU_CARE, "hospital")
  async onMonitor(@CurrentActor() actor: Actor, @Param("limitId") limitId: string): Promise<{ ok: true }> {
    await refusing(() => confirmLimitOnMonitor(this.db, actor, limitId));
    return { ok: true };
  }

  @Post("alarms/ack")
  @RequirePermission(ICU_CARE, "hospital")
  async ack(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => acknowledgeAlarm(this.db, actor, body)); }

  /* ═══ lines and bundles (D8) ═══ */
  @Post("lines")
  @RequirePermission(ICU_CARE, "hospital")
  async line(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => insertLine(this.db, actor, body)); }

  @Post("lines/remove")
  @RequirePermission(ICU_CARE, "hospital")
  async lineOut(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    await refusing(() => removeLine(this.db, actor, body));
    return { ok: true };
  }

  @Post("bundles/sepsis")
  @RequirePermission(ICU_CARE, "hospital")
  async sepsis(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => startSepsisBundle(this.db, actor, body)); }

  @Post("bundles/done")
  @RequirePermission(ICU_CARE, "hospital")
  async bundleDone(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    await refusing(() => completeBundle(this.db, actor, body));
    return { ok: true };
  }

  /* ═══ family (D9) ═══ */
  @Post("visits")
  @RequirePermission(ICU_CARE, "hospital")
  async visit(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => logVisit(this.db, actor, body)); }

  @Post("family-updates")
  @RequirePermission(ICU_CARE, "hospital")
  async familyUpdate(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => logFamilyUpdate(this.db, actor, body)); }

  /* ═══ the hall's gateway (manage) ═══ */
  @Post("gateways")
  @RequirePermission(ICU_MANAGE, "hospital")
  async gateway(@CurrentActor() actor: Actor, @Body() body: unknown) { return refusing(() => registerGateway(this.db, actor, body)); }

  @Post("gateways/slots")
  @RequirePermission(ICU_MANAGE, "hospital")
  async slot(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    await refusing(() => mapSlot(this.db, actor, body));
    return { ok: true };
  }

  @Post("gateways/codes")
  @RequirePermission(ICU_MANAGE, "hospital")
  async code(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ok: true }> {
    await refusing(() => mapCode(this.db, actor, body));
    return { ok: true };
  }
}
