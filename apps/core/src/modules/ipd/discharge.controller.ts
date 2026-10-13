import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { TariffError } from "../tariff";
import { cancelFit, confirmCharges, declareFit, readSummary, saveSummaryDraft, signSummary } from "./discharge";
import { askDuesApproval, listBillDesk, prepareFinalBill, readFinalBill, recordDuesApproval, settleFinalBill } from "./discharge-bill";
import {
  issueGatePass, listMortuary, receiveBody, recordAbscond, recordDeath, recordLama, recordPoliceClearance, releaseBody, scanGatePass,
} from "./discharge-exit";
import { readDischargeBoard, readDischargeTracker } from "./discharge-read";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import {
  IPD_BILL_VIEW, IPD_DISCHARGE_BILL, IPD_DISCHARGE_CONFIRM, IPD_DISCHARGE_DECLARE, IPD_DISCHARGE_EXIT, IPD_DISCHARGE_VIEW, IPD_GATE_PASS,
  IPD_GATE_SCAN, IPD_MORTUARY_MANAGE,
} from "./manifest";
import type {
  Actor, IpdBillDesk, IpdDischargeBoard, IpdDischargeTracker, IpdFinalBill, IpdMortuaryEntry, IpdRefusalBody, IpdSummaryView,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E3.2 (#730) — the discharge routes (`IPD_DISCHARGE_ROUTES`). Thin: each route is its intent function, which re-checks
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
    const status = e.code === "ipd_forbidden" ? 403 : e.code === "admission_workflow_inactive" ? 503
      : e.code.endsWith("_not_found") ? 404 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof TariffError) throw new HttpException({ statusCode: 422, code: e.code, message: e.message }, 422);
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const admissionParam = z.ulid();
const prepareBody = z.strictObject({ admissionId: z.ulid() });
const duesApprovalBody = z.strictObject({ admissionId: z.ulid(), approvalId: z.ulid() });
const duesBody = z.strictObject({ admissionId: z.ulid(), amountPaise: z.number().int().positive(), note: z.string().trim().min(1).max(1000) });

@Controller("ipd")
export class IpdDischargeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("discharge/board")
  @RequirePermission(IPD_DISCHARGE_VIEW, "hospital")
  async board(@CurrentActor() actor: Actor): Promise<IpdDischargeBoard> {
    try { return await readDischargeBoard(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("discharge/declare-fit")
  @RequirePermission(IPD_DISCHARGE_DECLARE, "hospital")
  async declareFit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await declareFit(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/cancel-fit")
  @RequirePermission(IPD_DISCHARGE_DECLARE, "hospital")
  async cancelFit(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cancelFit(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/confirm")
  @RequirePermission(IPD_DISCHARGE_CONFIRM, "hospital")
  async confirm(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await confirmCharges(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/summary")
  @RequirePermission(IPD_DISCHARGE_DECLARE, "hospital")
  async saveSummary(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IpdSummaryView> {
    try { return await saveSummaryDraft(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/summary/sign")
  @RequirePermission(IPD_DISCHARGE_DECLARE, "hospital")
  async signSummary(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await signSummary(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/bill/prepare")
  @RequirePermission(IPD_DISCHARGE_BILL, "hospital")
  async prepareBill(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IpdFinalBill> {
    try { return await prepareFinalBill(this.db, actor, prepareBody.parse(body).admissionId); } catch (e) { toHttp(e); }
  }

  @Post("discharge/bill/settle")
  @RequirePermission(IPD_DISCHARGE_BILL, "hospital")
  async settle(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await settleFinalBill(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/bill/ask-dues")
  @RequirePermission(IPD_DISCHARGE_BILL, "hospital")
  async askDues(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ approvalId: string }> {
    try { return await askDuesApproval(this.db, actor, duesBody.parse(body)); } catch (e) { toHttp(e); }
  }

  /** Review #762: the bill desk — settled bills with dues awaiting approval, a stay not out, an ending after the bill. */
  @Get("discharge/bill-desk")
  @RequirePermission(IPD_DISCHARGE_BILL, "hospital")
  async billDesk(@CurrentActor() actor: Actor): Promise<IpdBillDesk> {
    try { return await listBillDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  /** Review #762 RED 7 ⚖: the dues approval attached after the exit (a ledger step). */
  @Post("discharge/bill/dues-approval")
  @RequirePermission(IPD_DISCHARGE_BILL, "hospital")
  async duesApproval(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordDuesApproval(this.db, actor, duesApprovalBody.parse(body)); } catch (e) { toHttp(e); }
  }

  @Post("discharge/gate-pass")
  @RequirePermission(IPD_GATE_PASS, "hospital")
  async issueGatePass(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await issueGatePass(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/gate-pass/scan")
  @RequirePermission(IPD_GATE_SCAN, "hospital")
  async scanGatePass(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await scanGatePass(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/lama")
  @RequirePermission(IPD_DISCHARGE_EXIT, "hospital")
  async lama(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordLama(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/abscond")
  @RequirePermission(IPD_DISCHARGE_EXIT, "hospital")
  async abscond(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordAbscond(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("discharge/death")
  @RequirePermission(IPD_DISCHARGE_DECLARE, "hospital")
  async death(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordDeath(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("discharge/:admissionId/summary")
  @RequirePermission(IPD_DISCHARGE_VIEW, "hospital")
  async summary(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdSummaryView> {
    try { return await readSummary(this.db, actor, admissionParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("discharge/:admissionId/bill")
  @RequirePermission(IPD_DISCHARGE_BILL, "hospital", { alsoAdmits: [IPD_BILL_VIEW] })
  async finalBill(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdFinalBill> {
    try { return await readFinalBill(this.db, actor, admissionParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("discharge/:admissionId")
  @RequirePermission(IPD_DISCHARGE_VIEW, "hospital")
  async tracker(@CurrentActor() actor: Actor, @Param("admissionId") id: string): Promise<IpdDischargeTracker> {
    try { return await readDischargeTracker(this.db, actor, admissionParam.parse(id)); } catch (e) { toHttp(e); }
  }

  @Get("mortuary")
  @RequirePermission(IPD_MORTUARY_MANAGE, "hospital")
  async mortuary(@CurrentActor() actor: Actor): Promise<IpdMortuaryEntry[]> {
    try { return await listMortuary(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("mortuary/receive")
  @RequirePermission(IPD_MORTUARY_MANAGE, "hospital")
  async receive(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IpdMortuaryEntry> {
    try { return await receiveBody(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mortuary/police-clearance")
  @RequirePermission(IPD_MORTUARY_MANAGE, "hospital")
  async clearance(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IpdMortuaryEntry> {
    try { return await recordPoliceClearance(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("mortuary/release")
  @RequirePermission(IPD_MORTUARY_MANAGE, "hospital")
  async release(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IpdMortuaryEntry> {
    try { return await releaseBody(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
