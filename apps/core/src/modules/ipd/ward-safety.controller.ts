import { Body, Controller, Get, HttpException, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { IpdMonthSchema } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { MaterialsError } from "../materials";
import { IpdError, IpdRefusal, ipdRefusalStatus } from "./errors";
import {
  IPD_ASSESSMENT_RECORD, IPD_EMAR_GIVE, IPD_NURSING_ASSIGN, IPD_NURSING_VIEW, IPD_RESTRAINT_ORDER, IPD_ROUND_SIGN, IPD_WARD_QUALITY, IPD_WARD_STOCK_USE,
} from "./permissions";
import { checkCrashCart, registerCrashCart, takeNarcoticKeys, useCrashCart } from "./ward-cart";
import { insertIpdLine, removeIpdLine, reviewIpdLine } from "./ward-lines";
import { readWardQuality, readWardSafety } from "./ward-quality";
import {
  applyRestraint, endRestraint, orderRestraint, readRestraintRegister, recordCareCheck, recordRestraintCheck, recordRestraintFamilyTold,
  recordRiskScore, recordSafetyEvent, reviewRestraint,
} from "./ward-safety";
import { raiseWardIndent, readWardStock, recordWardStockUse, setWardPar } from "./ward-stock";
import type { Actor, IpdRefusalBody, IpdRestraintRegister, IpdWardQuality, IpdWardSafety, IpdWardStock } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * WM-2 (#983, decisions 0089 / 0091) — the ward's safety, stock and quality routes (`IPD_WARD_SAFETY_ROUTES`). The door
 * asks the act's permission; an act that two kinds of people may do (a line inserted by a nurse or a doctor) asks the
 * nursing view at the door and decides inside.
 */
const STATUS: Partial<Record<string, number>> = {
  ward_not_found: 404, care_plan_not_found: 404, restraint_not_found: 404, line_not_found: 404, crash_cart_not_found: 404,
  patient_not_on_ward: 409, care_plan_ended: 409, restraint_not_active: 409, restraint_lapsed: 409, line_removed: 409, crash_cart_code_taken: 409,
  crash_cart_recount_required: 409, crash_cart_restock_required: 409, ward_stock_lot_expired: 409, nothing_to_indent: 409, ward_store_not_set: 409,
  restraint_psychiatrist_required: 403, agency_no_narcotic_keys: 403, student_no_narcotic_keys: 403, waive_needs_incharge: 403,
};

function toHttp(e: unknown): never {
  if (e instanceof IpdRefusal) {
    const status = ipdRefusalStatus(e.code);
    const body: IpdRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof IpdError) {
    const status = e.code === "ipd_forbidden" ? 403 : STATUS[e.code] ?? 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof MaterialsError) throw new HttpException({ statusCode: 422, code: e.code, message: e.message }, 422);
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
const wardRequired = z.object({ wardId: z.ulid() });
const monthQuery = z.object({ wardId: z.ulid(), month: IpdMonthSchema });
const registerQuery = z.object({ wardId: z.ulid().optional(), month: IpdMonthSchema });

@Controller("ipd/ward-safety")
export class IpdWardSafetyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @RequirePermission(IPD_NURSING_ASSIGN, "hospital")
  async safety(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdWardSafety> {
    try {
      const q = wardQuery.parse(query);
      return await readWardSafety(this.db, actor, q.wardId === undefined ? {} : { wardId: q.wardId });
    } catch (e) { toHttp(e); }
  }

  @Post("risk-score")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async riskScore(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordRiskScore(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("care-check")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async careCheck(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordCareCheck(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("restraint/order")
  @RequirePermission(IPD_RESTRAINT_ORDER, "hospital")
  async restraintOrder(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await orderRestraint(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("restraint/apply")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async restraintApply(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await applyRestraint(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("restraint/check")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async restraintCheck(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordRestraintCheck(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("restraint/review")
  @RequirePermission(IPD_RESTRAINT_ORDER, "hospital")
  async restraintReview(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reviewRestraint(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("restraint/family")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async restraintFamily(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordRestraintFamilyTold(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("restraint/end")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async restraintEnd(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await endRestraint(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("restraint/register")
  @RequirePermission(IPD_WARD_QUALITY, "hospital")
  async restraintRegister(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdRestraintRegister> {
    try {
      const q = registerQuery.parse(query);
      return await readRestraintRegister(this.db, actor, { month: q.month, ...(q.wardId === undefined ? {} : { wardId: q.wardId }) });
    } catch (e) { toHttp(e); }
  }

  /** A nurse or a doctor inserts a line (the act asks for either permission). */
  @Post("line/insert")
  @RequirePermission(IPD_NURSING_VIEW, "hospital")
  async lineInsert(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await insertIpdLine(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("line/review")
  @RequirePermission(IPD_ROUND_SIGN, "hospital")
  async lineReview(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reviewIpdLine(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("line/remove")
  @RequirePermission(IPD_NURSING_VIEW, "hospital")
  async lineRemove(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await removeIpdLine(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("cart/register")
  @RequirePermission(IPD_NURSING_ASSIGN, "hospital")
  async cartRegister(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await registerCrashCart(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("cart/check")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async cartCheck(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await checkCrashCart(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("cart/use")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async cartUse(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await useCrashCart(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("narcotic-keys")
  @RequirePermission(IPD_EMAR_GIVE, "hospital")
  async keys(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await takeNarcoticKeys(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("stock")
  @RequirePermission(IPD_NURSING_ASSIGN, "hospital")
  async stock(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdWardStock> {
    try { return await readWardStock(this.db, actor, wardRequired.parse(query)); } catch (e) { toHttp(e); }
  }

  @Post("stock/par")
  @RequirePermission(IPD_NURSING_ASSIGN, "hospital")
  async stockPar(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await setWardPar(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("stock/indent")
  @RequirePermission(IPD_NURSING_ASSIGN, "hospital")
  async stockIndent(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await raiseWardIndent(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("stock/use")
  @RequirePermission(IPD_WARD_STOCK_USE, "hospital")
  async stockUse(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordWardStockUse(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("event")
  @RequirePermission(IPD_ASSESSMENT_RECORD, "hospital")
  async safetyEvent(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordSafetyEvent(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Get("quality")
  @RequirePermission(IPD_WARD_QUALITY, "hospital")
  async quality(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<IpdWardQuality> {
    try { return await readWardQuality(this.db, actor, monthQuery.parse(query)); } catch (e) { toHttp(e); }
  }
}
