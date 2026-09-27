import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { SodViolationError } from "../../kernel/auth/sod";
import { httpError, idSchema, parsed, toHttp } from "./pharmacy-http";
import {
  debitNoteDocument, officeBillDraft, officeDraftReturns, officePay, officeRecall, officeReturnFromRecall, officeReturns, officeToday,
  purchaseOrderDocument, writeOffManifestDocument,
} from "./office";
import { draftPurchaseOrders, planPurchaseDrafts } from "./purchase-drafts";
import { officeExecuteMerge, officeGetMerge, officeItems, officeMergePreview, officeRaiseMerge } from "./item-merge";
import type { OfficeItems } from "./item-merge";
import type { ItemMergeView, MergePreview } from "../materials";
import type { OfficePay, OfficeRecall, OfficeReturns, OfficeToday } from "./office";
import type { BillDraft } from "../materials";
import type { PurchasePlan } from "./purchase-drafts";
import type { PoView, ReturnView } from "../materials";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";

/**
 * PARITY P2 — `/pharmacy/office`'s routes. The office FEDERATES: the order lifecycle itself is
 * `materials.controller.ts`'s (`/materials/purchase-orders/*`); these are the office's own reads, the
 * agent's plan and the person's "make the drafts", and the order's printable page.
 *
 * Guarded on `materials.po.raise`, the grant of the people who buy (materials_head, the pharmacist);
 * the paper on `materials.stock.read`, the grant that reads an order.
 */
const assignBody = z.object({
  assign: z.array(z.object({ itemId: idSchema, vendorId: idSchema, ratePaise: z.number().int().nonnegative().optional() })).max(200).optional(),
});

const draftReturnsBody = z.object({ vendorIds: z.array(idSchema).max(200).optional() });

const mergePairQuery = z.object({ survivorItemId: idSchema, mergedItemId: idSchema });
const raiseMergeBody = mergePairQuery.extend({ reason: z.string().trim().min(3).max(500), source: z.enum(["agent", "manual"]).optional() });

function officeHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw httpError(403, e.message, "sod_violation", { pairKey: e.pairKey });
  toHttp(e);
}

@Controller("pharmacy/office")
export class PharmacyOfficeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("materials.po.raise", "hospital")
  @Get("today")
  async today(@CurrentActor() actor: Actor): Promise<OfficeToday> {
    try {
      return await officeToday(this.db, actor, new Date());
    } catch (e) { officeHttp(e); }
  }

  @RequirePermission("materials.po.raise", "hospital")
  @Get("plan")
  async plan(): Promise<PurchasePlan> {
    try {
      return await planPurchaseDrafts(this.db, new Date());
    } catch (e) { officeHttp(e); }
  }

  /** The person's press of "make the drafts": DRAFT orders only, one per vendor. */
  @RequirePermission("materials.po.raise", "hospital")
  @Post("draft-orders")
  async draft(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ drafts: PoView[] }> {
    const b = parsed(assignBody, body ?? {});
    try {
      return { drafts: await draftPurchaseOrders(this.db, actor, new Date(), b.assign ?? []) };
    } catch (e) { officeHttp(e); }
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get("purchase-orders/:id/document")
  async document(@CurrentActor() actor: Actor, @Param("id") poId: string): Promise<RenderedDocument> {
    try {
      return await purchaseOrderDocument(this.db, actor, poId);
    } catch (e) { officeHttp(e); }
  }

  /** PARITY P3 — the pay side of the office: bills to match, held, due, overdue, runs, the agent's plan. */
  @RequirePermission("materials.bills.manage", "hospital")
  @Get("pay")
  async pay(@CurrentActor() actor: Actor): Promise<OfficePay> {
    try {
      return await officePay(this.db, actor, new Date());
    } catch (e) { officeHttp(e); }
  }

  // ═══ PARITY P4 — the returns side: expiry, returns to the supplier, write-offs, recalls ═══

  /** Expiring 30 / 60 / 90, the agent's return plan, returns in flight, write-offs, open recalls. */
  @RequirePermission("materials.returns.manage", "hospital")
  @Get("returns")
  async returns(@CurrentActor() actor: Actor): Promise<OfficeReturns> {
    try {
      return await officeReturns(this.db, actor, new Date());
    } catch (e) { officeHttp(e); }
  }

  /** The person's press of "make the drafts": one DRAFT return per vendor (the ones ticked, or all). */
  @RequirePermission("materials.returns.manage", "hospital")
  @Post("returns/draft")
  async draftReturns(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ drafts: ReturnView[] }> {
    const b = parsed(draftReturnsBody, body ?? {});
    try {
      return { drafts: await officeDraftReturns(this.db, actor, new Date(), b.vendorIds) };
    } catch (e) { officeHttp(e); }
  }

  /** Our debit note (a return note before dispatch), A4 for the browser to print. */
  @RequirePermission("materials.stock.read", "hospital")
  @Get("returns/:id/debit-note")
  async debitNote(@CurrentActor() actor: Actor, @Param("id") returnId: string): Promise<RenderedDocument> {
    try {
      return await debitNoteDocument(this.db, actor, returnId);
    } catch (e) { officeHttp(e); }
  }

  /** The BMW destruction manifest (a condemnation list before it is posted), A4. */
  @RequirePermission("materials.stock.read", "hospital")
  @Get("write-offs/:id/manifest")
  async manifest(@CurrentActor() actor: Actor, @Param("id") writeOffId: string): Promise<RenderedDocument> {
    try {
      return await writeOffManifestDocument(this.db, actor, writeOffId);
    } catch (e) { officeHttp(e); }
  }

  /** A recall with its read-only callback list — names and phone numbers, logged as a PHI read. */
  @RequirePermission("materials.recall.manage", "hospital")
  @Get("recalls/:id")
  async recall(@CurrentActor() actor: Actor, @Param("id") recallId: string): Promise<OfficeRecall> {
    try {
      return await officeRecall(this.db, actor, recallId);
    } catch (e) { officeHttp(e); }
  }

  /** One tap: the recalled batch into a draft return to its supplier. */
  @RequirePermission("materials.returns.manage", "hospital")
  @Post("recalls/:id/return")
  async recallReturn(@CurrentActor() actor: Actor, @Param("id") recallId: string): Promise<{ return: ReturnView }> {
    try {
      return { return: await officeReturnFromRecall(this.db, actor, recallId) };
    } catch (e) { officeHttp(e); }
  }

  // ═══ PHARMACY P6 (hygiene) — item merge: the duplicates the agent found, the sheet, the act ═══

  /** The items side: the agent's possible duplicates and the merges in flight. */
  @RequirePermission("materials.items.merge", "hospital")
  @Get("items")
  async items(@CurrentActor() actor: Actor): Promise<OfficeItems> {
    try {
      return await officeItems(this.db, actor);
    } catch (e) { officeHttp(e); }
  }

  /** The merge sheet: A and B side by side, what would move and what stays, and every reason it cannot go ahead now. */
  @RequirePermission("materials.items.merge", "hospital")
  @Get("item-merges/preview")
  async mergePreview(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<MergePreview> {
    const q = parsed(mergePairQuery, query);
    try {
      return await officeMergePreview(this.db, actor, q.survivorItemId, q.mergedItemId);
    } catch (e) { officeHttp(e); }
  }

  /** "Merge B into A", with the reason: every rule asked, the approval filed with the medical superintendent. */
  @RequirePermission("materials.items.merge", "hospital")
  @Post("item-merges")
  async raiseMerge(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ merge: ItemMergeView }> {
    const b = parsed(raiseMergeBody, body);
    try {
      return { merge: await officeRaiseMerge(this.db, actor, b) };
    } catch (e) { officeHttp(e); }
  }

  @RequirePermission("materials.items.merge", "hospital")
  @Get("item-merges/:id")
  async getMerge(@CurrentActor() actor: Actor, @Param("id") mergeId: string): Promise<{ merge: ItemMergeView }> {
    try {
      return { merge: await officeGetMerge(this.db, actor, mergeId) };
    } catch (e) { officeHttp(e); }
  }

  /** The act, once approved: one transaction, everything asked again. Not undone. */
  @RequirePermission("materials.items.merge", "hospital")
  @Post("item-merges/:id/merge")
  async executeMerge(@CurrentActor() actor: Actor, @Param("id") mergeId: string): Promise<{ merge: ItemMergeView }> {
    try {
      return { merge: await officeExecuteMerge(this.db, actor, mergeId) };
    } catch (e) { officeHttp(e); }
  }

  /** PARITY P3 — the agent's prefill of a bill from a posted GRN (IGST when the vendor is out of state). */
  @RequirePermission("materials.bills.manage", "hospital")
  @Get("bill-draft/:grnId")
  async billDraft(@CurrentActor() actor: Actor, @Param("grnId") grnId: string): Promise<BillDraft> {
    try {
      return await officeBillDraft(this.db, actor, grnId);
    } catch (e) { officeHttp(e); }
  }
}
