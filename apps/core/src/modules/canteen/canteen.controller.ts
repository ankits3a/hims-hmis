import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, Public, RequirePermission } from "../../kernel/auth/decorators";
import { FamilyAddressThrottle } from "../ipd";
import { bedMenu, confirmBedOrder, issueBedQr, placeBedOrder, waitingBedOrders } from "./bed-qr";
import { charityGrant, requestCharity } from "./charity";
import { CanteenRefusal, canteenHttpStatus } from "./errors";
import { CANTEEN_FINANCE, CANTEEN_MANAGE, CANTEEN_SELL, CANTEEN_VIEW } from "./names";
import { canteenDay, canteenMonthIncome, canteenSetup, deductionsCsv, findAdmission, myOpenSession, staffDeductions } from "./reads";
import { issueRentInvoice } from "./rent";
import { approveVariance, closeTill, getSale, openTill, sell } from "./sales";
import {
  createCostCentre, createDish, createFreeRule, createOutlet, createStaffCategory, createTill, dishesOf, issueStaffCard, setBedClassMeals,
  setDishPrice, setStaffRule,
} from "./setup";
import { staffCardQr } from "./staff-card";
import type { StaffCardQr } from "./staff-card";
import type {
  Actor, CanteenAdmissionLookup, CanteenBedMenu, CanteenCharityGrant, CanteenDay, CanteenDeductionRow, CanteenMonthIncome, CanteenRentInvoice, CanteenSale,
  CanteenSetupView, CanteenTillClose,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DishView } from "./setup";

/**
 * THE CANTEEN DOORS (#977). The door checks the permission; the intent re-checks it and owns every rule. A refusal
 * answers `{ code, message, fix }`. The bed page's two doors are `@Public()`: they authenticate by the bed QR's token in
 * the BODY (never the path — the edge logs paths) and are throttled per address. Charging the IPD bill from a bed lives
 * under the family page's cookie path (`/ipd/family/canteen`), where the family's OTP session cookie is sent.
 */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CanteenRefusal) {
      const status = canteenHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix, details: e.details }, status);
    }
    throw e;
  }
}

const VIEWERS = { alsoAdmits: [CANTEEN_SELL, CANTEEN_MANAGE, CANTEEN_FINANCE] } as const;

@Controller("canteen")
export class CanteenController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ═══ setup (canteen.manage; staff rules and cards: canteen.finance) ═══
  @Get("setup")
  @RequirePermission(CANTEEN_VIEW, "hospital", VIEWERS)
  async setup(@CurrentActor() actor: Actor): Promise<CanteenSetupView> { return refusing(() => canteenSetup(this.db, actor)); }

  @Get("outlets/:id/menu")
  @RequirePermission(CANTEEN_VIEW, "hospital", VIEWERS)
  async menu(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<DishView[]> { return refusing(() => dishesOf(this.db, actor, id)); }

  @Post("outlets")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async outlet(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ outletId: string }> { return refusing(() => createOutlet(this.db, actor, b)); }

  @Post("tills")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async till(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ tillId: string }> { return refusing(() => createTill(this.db, actor, b)); }

  @Post("dishes")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async dish(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ dishId: string }> { return refusing(() => createDish(this.db, actor, b)); }

  @Post("prices")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async price(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ priceId: string }> {
    return refusing(() => setDishPrice(this.db, actor, b, { now: new Date() }));
  }

  @Post("cost-centres")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async costCentre(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ costCentreId: string }> { return refusing(() => createCostCentre(this.db, actor, b)); }

  @Post("free-rules")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async freeRule(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ freeRuleId: string }> { return refusing(() => createFreeRule(this.db, actor, b)); }

  @Put("bed-class-meals")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async bedClassMeals(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ bedClass: string; mealsPerDay: number }> {
    return refusing(() => setBedClassMeals(this.db, actor, b));
  }

  @Post("bed-qrs")
  @RequirePermission(CANTEEN_MANAGE, "hospital")
  async bedQr(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ qrId: string; token: string }> { return refusing(() => issueBedQr(this.db, actor, b)); }

  @Post("staff-categories")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async category(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ categoryId: string }> { return refusing(() => createStaffCategory(this.db, actor, b)); }

  @Post("staff-rules")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async rule(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ ruleId: string }> { return refusing(() => setStaffRule(this.db, actor, b)); }

  @Post("staff-cards")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async card(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ cardId: string; version: number }> { return refusing(() => issueStaffCard(this.db, actor, b)); }

  /** The holder's own meal card QR (any logged-in person with a card; no permission). */
  @Get("my-card")
  async myCard(@CurrentActor() actor: Actor): Promise<StaffCardQr> { return refusing(() => staffCardQr(this.db, actor)); }

  // ═══ the till (canteen.sell) ═══
  @Get("my-session")
  @RequirePermission(CANTEEN_SELL, "hospital")
  async mySession(@CurrentActor() actor: Actor): Promise<CanteenTillClose | null> { return refusing(() => myOpenSession(this.db, actor)); }

  @Post("sessions")
  @RequirePermission(CANTEEN_SELL, "hospital")
  async open(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ sessionId: string }> { return refusing(() => openTill(this.db, actor, b)); }

  @Post("sales")
  @RequirePermission(CANTEEN_SELL, "hospital")
  async sale(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<CanteenSale> { return refusing(() => sell(this.db, actor, b)); }

  @Get("sales/:id")
  @RequirePermission(CANTEEN_VIEW, "hospital", VIEWERS)
  async readSale(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<CanteenSale> { return refusing(() => getSale(this.db, actor, id)); }

  @Post("sessions/:id/close")
  @HttpCode(200)
  @RequirePermission(CANTEEN_SELL, "hospital")
  async close(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<CanteenTillClose> {
    return refusing(() => closeTill(this.db, actor, { ...(b as object), sessionId: id }));
  }

  @Post("sessions/:id/approve-variance")
  @HttpCode(200)
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async approve(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<CanteenTillClose> {
    return refusing(() => approveVariance(this.db, actor, { ...(b as object), sessionId: id }));
  }

  @Get("admission")
  @RequirePermission(CANTEEN_SELL, "hospital")
  async admission(@CurrentActor() actor: Actor, @Query("q") q: string): Promise<CanteenAdmissionLookup> { return refusing(() => findAdmission(this.db, actor, q ?? "")); }

  @Get("bed-orders")
  @RequirePermission(CANTEEN_SELL, "hospital")
  async waiting(@CurrentActor() actor: Actor): Promise<CanteenSale[]> { return refusing(() => waitingBedOrders(this.db, actor)); }

  @Post("bed-orders/:id/confirm")
  @HttpCode(200)
  @RequirePermission(CANTEEN_SELL, "hospital")
  async confirm(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<CanteenSale> {
    return refusing(() => confirmBedOrder(this.db, actor, { ...(b as object), orderId: id }));
  }

  @Post("charity")
  @RequirePermission(CANTEEN_SELL, "hospital", { alsoAdmits: [CANTEEN_MANAGE] })
  async charity(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<{ grantId: string; approvalId: string }> { return refusing(() => requestCharity(this.db, actor, b)); }

  @Get("charity/:id")
  @RequirePermission(CANTEEN_VIEW, "hospital", VIEWERS)
  async grant(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<CanteenCharityGrant> { return refusing(() => charityGrant(this.db, actor, id)); }

  // ═══ the day and finance ═══
  @Get("day")
  @RequirePermission(CANTEEN_VIEW, "hospital", { alsoAdmits: [CANTEEN_MANAGE, CANTEEN_FINANCE] })
  async day(@CurrentActor() actor: Actor, @Query("date") date: string): Promise<CanteenDay> { return refusing(() => canteenDay(this.db, actor, { date })); }

  @Get("month")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async month(@CurrentActor() actor: Actor, @Query("month") month: string): Promise<CanteenMonthIncome> {
    return refusing(() => canteenMonthIncome(this.db, actor, { month }));
  }

  @Get("deductions")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async deductions(@CurrentActor() actor: Actor, @Query("month") month: string): Promise<CanteenDeductionRow[]> {
    return refusing(() => staffDeductions(this.db, actor, { month }));
  }

  @Get("deductions.csv")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async deductionsFile(@CurrentActor() actor: Actor, @Query("month") month: string, @Res({ passthrough: true }) res: CsvRes): Promise<string> {
    const rows = await refusing(() => staffDeductions(this.db, actor, { month }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="canteen-deductions-${month.replace(/[^0-9-]/g, "")}.csv"`);
    return deductionsCsv(rows);
  }

  @Post("rent-invoices")
  @RequirePermission(CANTEEN_FINANCE, "hospital")
  async rent(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<CanteenRentInvoice> { return refusing(() => issueRentInvoice(this.db, actor, b)); }
}

type CsvRes = { setHeader(name: string, value: string): void };
type BedReq = { ip?: string; headers: Record<string, string | string[] | undefined> };

const FAMILY_DEVICE_COOKIE = "hmis_fdev";
const FAMILY_SESSION_COOKIE = "hmis_fses";

function familyCookies(req: BedReq): { device?: string; session?: string } {
  const raw = req.headers.cookie;
  const header = Array.isArray(raw) ? raw.join(";") : raw ?? "";
  const out: { device?: string; session?: string } = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(v)) continue;
    if (k === FAMILY_DEVICE_COOKIE) out.device = v;
    if (k === FAMILY_SESSION_COOKIE) out.session = v;
  }
  return out;
}

const bodyToken = (b: unknown): string => {
  const t = (b as { token?: unknown } | null)?.token;
  return typeof t === "string" ? t : "";
};
const withoutToken = (b: unknown): Record<string, unknown> => {
  const rest = { ...((typeof b === "object" && b !== null ? b : {}) as Record<string, unknown>) };
  delete rest.token;
  delete rest.familyToken;
  return rest;
};

/** The bed's QR page (no login): the token travels in the body. Throttled per address. */
@Controller()
export class CanteenBedController {
  private readonly throttle = new FamilyAddressThrottle();

  private allow(req: BedReq): void {
    if (!this.throttle.allow(req.ip ?? "unknown")) {
      throw new HttpException({ statusCode: 429, code: "bed_qr_throttled", message: "Too many requests.", fix: "Wait a few minutes." }, 429);
    }
  }
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Post("canteen/bed/menu")
  @HttpCode(200)
  async menu(@Req() req: BedReq, @Body() b: unknown): Promise<CanteenBedMenu> {
    this.allow(req);
    return refusing(() => bedMenu(this.db, bodyToken(b)));
  }

  @Public()
  @Post("canteen/bed/order")
  @HttpCode(200)
  async order(@Req() req: BedReq, @Body() b: unknown): Promise<CanteenSale> {
    this.allow(req);
    return refusing(() => placeBedOrder(this.db, bodyToken(b), withoutToken(b)));
  }

  /** On the IPD bill: under the family page's cookie path, so the family's OTP session comes with it. */
  @Public()
  @Post("ipd/family/canteen/order")
  @HttpCode(200)
  async familyOrder(@Req() req: BedReq, @Body() b: unknown): Promise<CanteenSale> {
    this.allow(req);
    const familyToken = (b as { familyToken?: unknown } | null)?.familyToken;
    return refusing(() => placeBedOrder(this.db, bodyToken(b), withoutToken(b), {
      family: { token: typeof familyToken === "string" ? familyToken : "", ...familyCookies(req) },
    }));
  }
}
