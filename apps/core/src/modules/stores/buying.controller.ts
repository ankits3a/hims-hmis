import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  storesBudgetBody, storesDelegationBody, storesPrBandBody, storesPrBulkBody, storesPrDeclineBody, storesPurchaseRequestBody, storesSupplierCategoryBody,
  storesSupplierFieldsBody,
} from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { STORES_BUDGET_MANAGE, STORES_BUYING_MANAGE, STORES_GRN_QC, STORES_MASTERS } from "./access";
import { budgetView, setDepartmentBudget } from "./budgets";
import { budgetsForMonth, buyContext, delegationCandidates } from "./buy-reads";
import { delegateApprovals, myDelegations } from "./delegations";
import { postStoresGrn, signStoresQc, storesGrnsForQc } from "./grn-qc";
import {
  approvePurchaseRequest, bulkApprovePurchaseRequests, cancelPurchaseRequest, declinePurchaseRequest, myPurchaseRequests, previewPurchaseLine,
  purchaseRequestsToApprove, raisePurchaseRequest, readPurchaseRequest, setPurchaseRequestBand,
} from "./purchase-requests";
import { approveSupplierCategory, setSupplierFields, storesSuppliers } from "./suppliers";
import { parsed, toHttp } from "./stores-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const id = z.string().min(1).max(64);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

/**
 * STORES S5a (#1115) — `/stores/buy/*`, `/stores/purchase-requests/*`, `/stores/budgets*`, `/stores/delegations*`,
 * `/stores/grns/*`, `/stores/suppliers*`: the front of the buying desk.
 *
 * Department routes (ask, approve, delegate) carry NO route guard, the shelf routes' posture: the department is a fact
 * of the request, and every intent asks `stores.purchase.request` / `stores.indents.approve` AT it (or finds the live
 * delegation). Hospital routes carry their grant: finance's budgets, the buyer's suppliers, the non-drug QC.
 */
@Controller("stores")
export class StoresBuyingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("buy/context")
  async context(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await buyContext(this.db, actor); } catch (e) { toHttp(e); }
  }

  /* ─────────────── purchase requests ─────────────── */

  @Post("purchase-requests")
  async raise(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesPurchaseRequestBody, body);
    try { return await raisePurchaseRequest(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Get("purchase-requests/preview")
  async preview(@CurrentActor() actor: Actor, @Query("itemId") itemId: string, @Query("departmentId") departmentId?: string): Promise<unknown> {
    try {
      return await previewPurchaseLine(this.db, actor, { itemId: parsed(id, itemId), departmentId: departmentId === undefined || departmentId === "" ? null : parsed(id, departmentId) });
    } catch (e) { toHttp(e); }
  }

  @Get("purchase-requests/mine")
  async mine(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { requests: await myPurchaseRequests(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("purchase-requests/to-approve")
  async toApprove(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { requests: await purchaseRequestsToApprove(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Post("purchase-requests/bulk-approve")
  async bulk(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesPrBulkBody, body);
    try { return { requests: await bulkApprovePurchaseRequests(this.db, actor, b.ids) }; } catch (e) { toHttp(e); }
  }

  @Get("purchase-requests/:prId")
  async one(@CurrentActor() actor: Actor, @Param("prId") prId: string): Promise<unknown> {
    try { return await readPurchaseRequest(this.db, actor, parsed(id, prId)); } catch (e) { toHttp(e); }
  }

  @Post("purchase-requests/:prId/approve")
  async approve(@CurrentActor() actor: Actor, @Param("prId") prId: string): Promise<unknown> {
    try { return await approvePurchaseRequest(this.db, actor, parsed(id, prId)); } catch (e) { toHttp(e); }
  }

  @Post("purchase-requests/:prId/decline")
  async decline(@CurrentActor() actor: Actor, @Param("prId") prId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesPrDeclineBody, body);
    try { return await declinePurchaseRequest(this.db, actor, parsed(id, prId), b.reason); } catch (e) { toHttp(e); }
  }

  @Post("purchase-requests/:prId/cancel")
  async cancel(@CurrentActor() actor: Actor, @Param("prId") prId: string): Promise<unknown> {
    try { return await cancelPurchaseRequest(this.db, actor, parsed(id, prId)); } catch (e) { toHttp(e); }
  }

  @Post("purchase-requests/:prId/band")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async band(@CurrentActor() actor: Actor, @Param("prId") prId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesPrBandBody, body);
    try { return await setPurchaseRequestBand(this.db, actor, parsed(id, prId), b.band, b.reason); } catch (e) { toHttp(e); }
  }

  /* ─────────────── budgets (finance; the HOD reads its own) ─────────────── */

  @Get("budgets/month")
  @RequirePermission(STORES_BUDGET_MANAGE, "hospital")
  async budgetsMonth(@CurrentActor() actor: Actor, @Query("month") m: string): Promise<unknown> {
    try { return { departments: await budgetsForMonth(this.db, actor, parsed(month, m)) }; } catch (e) { toHttp(e); }
  }

  @Get("budgets")
  async budget(@CurrentActor() actor: Actor, @Query("departmentId") departmentId: string, @Query("month") m: string): Promise<unknown> {
    try { return await budgetView(this.db, actor, parsed(id, departmentId), parsed(month, m)); } catch (e) { toHttp(e); }
  }

  @Post("budgets")
  @RequirePermission(STORES_BUDGET_MANAGE, "hospital")
  async setBudget(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesBudgetBody, body);
    try { return { budgets: await setDepartmentBudget(this.db, actor, b) }; } catch (e) { toHttp(e); }
  }

  /* ─────────────── delegation (the HOD) ─────────────── */

  @Get("delegations/mine")
  async delegations(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { delegations: await myDelegations(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Get("delegations/candidates")
  async candidates(@CurrentActor() actor: Actor, @Query("departmentId") departmentId: string): Promise<unknown> {
    try { return { people: await delegationCandidates(this.db, actor, parsed(id, departmentId)) }; } catch (e) { toHttp(e); }
  }

  @Post("delegations")
  async delegate(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesDelegationBody, body);
    try {
      return await delegateApprovals(this.db, actor, { ...b, from: new Date(b.from), to: new Date(b.to) });
    } catch (e) { toHttp(e); }
  }

  /* ─────────────── non-drug GRN QC ─────────────── */

  @Get("grns/for-qc")
  @RequirePermission(STORES_GRN_QC, "hospital")
  async grnsForQc(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { grns: await storesGrnsForQc(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Post("grns/:grnId/qc")
  @RequirePermission(STORES_GRN_QC, "hospital")
  async qc(@CurrentActor() actor: Actor, @Param("grnId") grnId: string): Promise<unknown> {
    try { return await signStoresQc(this.db, actor, parsed(id, grnId)); } catch (e) { toHttp(e); }
  }

  @Post("grns/:grnId/post")
  @RequirePermission(STORES_GRN_QC, "hospital")
  async post(@CurrentActor() actor: Actor, @Param("grnId") grnId: string): Promise<unknown> {
    try { return await postStoresGrn(this.db, actor, parsed(id, grnId)); } catch (e) { toHttp(e); }
  }

  /* ─────────────── suppliers (the buyer; category approval the materials head's) ─────────────── */

  @Get("suppliers")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async suppliers(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return { suppliers: await storesSuppliers(this.db, actor) }; } catch (e) { toHttp(e); }
  }

  @Post("suppliers/:vendorId/fields")
  @RequirePermission(STORES_BUYING_MANAGE, "hospital")
  async supplierFields(@CurrentActor() actor: Actor, @Param("vendorId") vendorId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesSupplierFieldsBody, body);
    try { return await setSupplierFields(this.db, actor, parsed(id, vendorId), b); } catch (e) { toHttp(e); }
  }

  @Post("suppliers/:vendorId/categories")
  @RequirePermission(STORES_MASTERS, "hospital")
  async supplierCategory(@CurrentActor() actor: Actor, @Param("vendorId") vendorId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(storesSupplierCategoryBody, body);
    try { await approveSupplierCategory(this.db, actor, parsed(id, vendorId), b.categoryId); return { ok: true }; } catch (e) { toHttp(e); }
  }
}
