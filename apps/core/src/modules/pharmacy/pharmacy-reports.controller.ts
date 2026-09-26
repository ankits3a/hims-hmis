import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { listStores } from "../materials";
import { documentActivity, recentActivity } from "./activity";
import { gstr2bReconcile } from "./gstr2b";
import { officeNonMoving, officePurchaseRegister, officeStockValuation } from "./office-reports";
import { parsed, toHttp } from "./pharmacy-http";
import { REPORTS_MARGIN, REPORTS_READ, requireReportPermission } from "./report-range";
import { hsnReport, marginReport, salesRegister } from "./sales-register";
import type { ActivityFeedRow, ActivityTimeline } from "./activity";
import type { Gstr2bRecon } from "./gstr2b";
import type { HsnReport, MarginReport, ReportInput, SalesRegister } from "./sales-register";
import type { NonMovingReport, PurchaseRegister, StockValuation } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PARITY P5 — the office's Reports (`/pharmacy/office`, Reports side). Every route reads; nothing is
 * written. Guarded on `pharmacy.reports.read` (the owner, the materials head, the pharmacist in
 * charge, the billing office); the margin on `pharmacy.reports.margin` as well — and each read
 * asserts its permission again inside, whatever the route checked.
 */
type RangeQuery = { preset?: string; from?: string; to?: string; store?: string; groupBy?: string };
const rangeOf = (q: RangeQuery): ReportInput & { groupBy?: string } => ({
  ...(q.preset === undefined ? {} : { preset: q.preset }),
  from: q.from ?? null, to: q.to ?? null, storeCode: q.store ?? null,
  ...(q.groupBy === undefined ? {} : { groupBy: q.groupBy }),
});

const gstr2bBody = z.object({
  format: z.enum(["json", "csv"]),
  content: z.string().min(1).max(990_000),
  preset: z.string().max(16).optional(),
  from: z.string().max(10).nullable().optional(),
  to: z.string().max(10).nullable().optional(),
});

@Controller("pharmacy/office/reports")
export class PharmacyReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The stores a report can be filtered to (the owner reads no materials screen to find them). */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("stores")
  async stores(@CurrentActor() actor: Actor): Promise<{ stores: { code: string; name: string }[] }> {
    try {
      await requireReportPermission(this.db, actor, REPORTS_READ, "the report filters");
      return { stores: (await listStores(this.db)).map((s) => ({ code: s.code, name: s.name })) };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("sales")
  async sales(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<SalesRegister> {
    try { return await salesRegister(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_MARGIN, "hospital")
  @Get("margin")
  async margin(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<MarginReport> {
    try { return await marginReport(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("hsn")
  async hsn(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<HsnReport> {
    try { return await hsnReport(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("purchases")
  async purchases(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<PurchaseRegister & { preset: string }> {
    try { return await officePurchaseRegister(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("valuation")
  async valuation(@CurrentActor() actor: Actor, @Query("asOf") asOf?: string, @Query("store") store?: string): Promise<StockValuation> {
    try { return await officeStockValuation(this.db, actor, { asOf: asOf ?? null, storeCode: store ?? null }, new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("non-moving")
  async nonMoving(@CurrentActor() actor: Actor, @Query("days") days?: string, @Query("store") store?: string): Promise<NonMovingReport> {
    try { return await officeNonMoving(this.db, actor, { days: days ?? null, storeCode: store ?? null }, new Date()); } catch (e) { toHttp(e); }
  }

  /** The accountant's GSTR-2B file, read and matched; never stored. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Post("gstr2b")
  async gstr2b(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<Gstr2bRecon> {
    const b = parsed(gstr2bBody, body);
    try {
      return await gstr2bReconcile(this.db, actor, {
        format: b.format, content: b.content, ...(b.preset === undefined ? {} : { preset: b.preset }), from: b.from ?? null, to: b.to ?? null,
      }, new Date());
    } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("activity")
  async activity(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<{ from: string; to: string; rows: ActivityFeedRow[] }> {
    try { return await recentActivity(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  @RequirePermission(REPORTS_READ, "hospital")
  @Get("activity/document")
  async document(@CurrentActor() actor: Actor, @Query("no") no?: string): Promise<ActivityTimeline> {
    try { return await documentActivity(this.db, actor, no ?? ""); } catch (e) { toHttp(e); }
  }
}
