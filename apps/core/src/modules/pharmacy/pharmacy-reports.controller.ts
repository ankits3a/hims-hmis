import { BadRequestException, Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { rangeProblem } from "@hmis/contracts";
import type { OwnerPharmacy } from "@hmis/contracts";
import { istDateOf } from "./config";
import { ownerPharmacy } from "./owner-summary";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { listStores } from "../materials";
import { documentActivity, recentActivity } from "./activity";
import { creditNoteRegister } from "./credit-notes";
import { gstBook, ticketInvoices } from "./ticket-books";
import { pharmacyAccounts } from "./accounts";
import type { PharmacyAccounts } from "./accounts";
import type { GstBook, TicketInvoices } from "./ticket-books";
import type { CreditNoteRegister } from "./credit-notes";
import { gstr2bReconcile } from "./gstr2b";
import { gstr3bReport } from "./gstr3b";
import { officeNonMoving, officePurchaseRegister, officeStockValuation } from "./office-reports";
import { dailyStock, itemCatalogueReport, lossRegister, topSellingItems } from "./office-stock-reports";
import { parsed, toHttp } from "./pharmacy-http";
import { REPORTS_MARGIN, REPORTS_READ, requireReportPermission } from "./report-range";
import { hsnReport, marginReport, salesRegister } from "./sales-register";
import type { ActivityFeedRow, ActivityTimeline } from "./activity";
import type { Gstr2bRecon } from "./gstr2b";
import type { Gstr3b } from "./gstr3b";
import type { ItemCatalogueReport, LossRegister, TopSelling } from "./office-stock-reports";
import type { HsnReport, MarginReport, ReportInput, SalesRegister } from "./sales-register";
import type { NonMovingReport, PurchaseRegister, StockMovementSummary, StockValuation } from "../materials";
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

  /** Owner 2026-10-03 — the pharmacy's accounts for the CA: sales, GST, money in and out, credit, purchases, every document. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("accounts")
  async accounts(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<PharmacyAccounts> {
    try { return await pharmacyAccounts(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /** Owner 2026-10-03 — every bill in the range with its ticket, GST, credit notes against it and credit spent. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("ticket-invoices")
  async ticketInvoices(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<TicketInvoices> {
    try { return await ticketInvoices(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /** Owner 2026-10-03 — the GST book for the CA: rate-wise sales, returns and net; credit notes with their bills; the money check. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("gst-book")
  async gstBook(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<GstBook> {
    try { return await gstBook(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /** Owner 2026-10-03 — the pharmacy's credit notes in the range: to whom, how much, and what became of the money. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("credit-notes")
  async creditNotes(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<CreditNoteRegister> {
    try { return await creditNoteRegister(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /**
   * THE OWNER'S PHARMACY PAGE IN THE STAFF APP (owner 2026-10-09) — `owner-summary.ts`: totals for the
   * IST days `from`..`to` (today when absent; at most 92, never the future) and a comparison range
   * `cfrom`..`cto`. THE ONE ROUTE HERE NOT ON `pharmacy.reports.read`: it is the hospital's figures
   * (`staff.reports.read` — the owner and the Medical Superintendent), counts for whoever holds that,
   * and RUPEES only for a reader who also holds the pharmacy's reports. No patient, no bill number.
   */
  @RequirePermission("staff.reports.read", "hospital")
  @Get("owner-summary")
  async ownerSummary(@CurrentActor() actor: Actor, @Query() q: { from?: string; to?: string; cfrom?: string; cto?: string }): Promise<OwnerPharmacy> {
    const now = new Date();
    const today = istDateOf(now);
    const from = q.from ?? q.to ?? today, to = q.to ?? q.from ?? today;
    const bad = rangeProblem(from, to, today) ?? (q.cfrom === undefined && q.cto === undefined ? null : rangeProblem(q.cfrom, q.cto, today));
    if (bad !== null) throw new BadRequestException({ message: `the range cannot be read: ${bad}`, code: "invalid_range" });
    try {
      return await ownerPharmacy(this.db, actor, { from, to }, q.cfrom === undefined ? null : { from: q.cfrom, to: q.cto! }, now);
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

  /** STAGE C — the period's items ranked by units and by value (net of refunds), with share and ABC class. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("top-selling")
  async topSelling(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<TopSelling> {
    try { return await topSellingItems(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /** STAGE C — every loss booked in the period: destruction write-offs and count variances written off. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("losses")
  async losses(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<LossRegister> {
    try { return await lossRegister(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /** STAGE C — per item: opening + in − out = closing over the range, from the ledger. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("daily-stock")
  async daily(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<StockMovementSummary & { preset: string; storeCode: string | null }> {
    try { return await dailyStock(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
  }

  /** STAGE C — the item master as one sheet (for an inspection, or the CA). */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("catalogue")
  async catalogue(@CurrentActor() actor: Actor, @Query("store") store?: string): Promise<ItemCatalogueReport> {
    try { return await itemCatalogueReport(this.db, actor, { storeCode: store ?? null }); } catch (e) { toHttp(e); }
  }

  /** GAP A4 — the period's GSTR-3B figures from the books: outward tax, ITC, and rule 88A's set-off. */
  @RequirePermission(REPORTS_READ, "hospital")
  @Get("gstr3b")
  async gstr3b(@CurrentActor() actor: Actor, @Query() q: RangeQuery): Promise<Gstr3b> {
    try { return await gstr3bReport(this.db, actor, rangeOf(q), new Date()); } catch (e) { toHttp(e); }
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
