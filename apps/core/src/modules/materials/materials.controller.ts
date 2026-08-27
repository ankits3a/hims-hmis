import {
  BadRequestException, Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { ApprovalError } from "../../kernel/approvals/types";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { MaterialsError, materialsHttpStatus } from "./errors";
import {
  addBarcode, addItemUom, getItem, listItems, registerItem, resolveBarcode, setPriceRegulation,
  updateItem,
} from "./items";
import {
  activateVendor, addVendorDocument, applyBankChange, blacklistVendor, getBankChange, getVendor,
  listBankChanges, listVendorDocuments, listVendors, registerVendor, reinstateVendor,
  requestBankChange, suspendVendor, updateVendor,
} from "./vendors";
import { createStore, listStores } from "./stores";
import { balances, movementsFor, recallBatch } from "./ledger";
import {
  captureGrn, getGrn, listGrns, postGrn, requestNearExpiryAcceptance, runGateQc,
} from "./grn";
import { getTransfer, issueStock, listDiscrepancies, listTransfers, receiveStock } from "./transfers";
import { consumptionsFor } from "./consumption";
import { expiringBatches } from "./expiry";
import { BLACKLIST_REASONS } from "./config";
import type { BlacklistReason } from "./config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 14 T8 — the materials module's HTTP surface.
 *
 * ═══ `toHttp` GOES THROUGH THE SHARED MAPPER, AND PLAN 13 IS WHY THIS PARAGRAPH IS IN CAPITALS ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped `billing.controller.ts`'s `toHttp` and reached a
 * busy counter as a 500. **Plan 13 then shipped the same defect a second time, INTRODUCED BY THE
 * FIX for the first**: its remediation added an error code and not a mapping, so a kernel refusal
 * escaped an OPD controller as a 500 — and the second reviewer found it in the remediation, not in
 * the original.
 *
 * So: `materialsHttpStatus` lives in `errors.ts` BESIDE the codes, it is exported, and this
 * controller maps through it rather than through a private table. **Every route below that can
 * raise a `MaterialsError` wraps its call in `toHttp`** — including the read routes, because
 * `requireStore` and `getBankChange` both refuse — and `materials.e2e.test.ts` walks a refusal from
 * every family to a 4xx so that the mapping is EXECUTED rather than asserted.
 *
 * An error this mapper does not recognise RETHROWS: a 500 is a genuine bug and should be loud (the
 * patients/opd convention).
 *
 * ═══ GLOBAL GUARDS, PER-ROUTE PERMISSIONS ═══
 *
 * AuthGuard/PermissionGuard are global APP_GUARDs from AuthModule (order load-bearing, Plan 02), so
 * mounting this controller mounts its permission checks with it — which is why every route carries
 * `@RequirePermission` and none carries a check of its own (Plan 13 T5's recorded rule).
 *
 * **There is NO route for `reserveStock`** (DD18, and Plan 13 DD14's posture): the reservation
 * functions ship with tests and no HTTP surface, and the first caller — 16c's dispense counter —
 * mounts one with the permission it needs. A route nobody calls is a route nobody guards correctly.
 */
function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

/**
 * Unrecognised errors rethrow — see the header.
 *
 * ═══ `ApprovalError` IS MAPPED HERE, AND IT WAS MISSING UNTIL THE e2e CAUGHT IT — finding F13 ═══
 *
 * Two of this module's routes call the approvals engine: `POST vendors/:id/bank-change` (O-6) and
 * `POST grns/:id/near-expiry-request` (DD10). The engine raises `ApprovalError` for `unknown_type`,
 * `user_actor_required`, `definition_not_active`, `amount_needs_target` and the SoD refusals — none
 * of which is a `MaterialsError`, so **without this clause every one of them reached the vendor desk
 * as a 500.**
 *
 * That is Plan 09's defect and Plan 13's, a third time, in the phase whose own `errors.ts` header
 * warns about exactly it — which is the point worth keeping: the warning was written, read, and
 * still not enough. What caught it was `materials.e2e.test.ts` driving a real request through a
 * database with no approval type registered and asserting a 201. It got a 500, and the suite said
 * so before a hospital did.
 *
 * `billing.controller.ts:144` is the shape copied: 409 with the engine's own CODE carried through,
 * so a screen can distinguish "this approval type was never registered" (an operator fixes it with
 * a seed) from "you may not approve your own request" (a second person must).
 */
export function toHttp(e: unknown): never {
  if (e instanceof MaterialsError) throw httpError(materialsHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof ApprovalError) throw httpError(409, e.message, e.code);
  /**
   * ═══ CLOSE REVIEW M1 — THE FOURTH DOOR, AND THE REPO HAD ALREADY SHUT IT ONCE ═══
   *
   * `POST /materials/stores` reaches `createResource`, which raises `ResourceError` for
   * `duplicate_code`, `unknown_resource` (a stale `parentId`), `too_deep`, `unknown_status` and
   * `unknown_kind`. None is a `MaterialsError` or an `ApprovalError`, there is no global exception
   * filter in this app, so every one of them answered **500**.
   *
   * `modules/opd/opd-masters.controller.ts` carries this exact clause, added by **Plan 13's own
   * close pass** under the heading "THIS CONTROLLER CAN RECEIVE A `ResourceError`, SO IT MAPS ONE".
   * This is the third module to learn it and the second to learn it from a reviewer. The e2e's
   * "never a 500" leg walked six families and not `stores` — the one family with an unmapped class,
   * which is exactly how a guard that looks thorough leaves the only gap that matters.
   */
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code);
  throw e;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

// Query flags arrive as strings; never `z.coerce.boolean()` — it reads "false" as true (§3.19).
const flagQuery = z.enum(["true", "false"]).optional();
const id = z.string().min(1).max(64);
const code = z.string().min(1).max(64);
const name = z.string().min(1).max(200);
const paise = z.number().int();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const uomInput = z.object({
  uom: z.string().min(1).max(32), toBaseMultiplier: z.number().int().positive(),
  isPurchaseUom: z.boolean().optional(), isIssueUom: z.boolean().optional(),
});
const barcodeInput = z.object({
  code: z.string().min(1).max(64), packUom: z.string().min(1).max(32), vendorId: id.nullish(),
});

const itemCreateBody = z.object({
  code, name, class: z.string().min(1).max(32), baseUom: z.string().min(1).max(32),
  batchTracked: z.boolean(), formularyMedicineId: id.nullish(),
  hsnCode: z.string().max(16).nullish(), gstRateBps: z.number().int().nullish(),
  serialTracked: z.boolean().optional(), storageClass: z.string().max(32).optional(),
  shelfLifeDays: z.number().int().positive().nullish(),
  abcClass: z.string().max(4).nullish(), vedClass: z.string().max(4).nullish(),
  uoms: z.array(uomInput).max(20).optional(), barcodes: z.array(barcodeInput).max(20).optional(),
});
const itemPatchBody = z.object({
  name: name.optional(), class: z.string().min(1).max(32).optional(),
  formularyMedicineId: id.nullish(), hsnCode: z.string().max(16).nullish(),
  gstRateBps: z.number().int().nullish(), serialTracked: z.boolean().optional(),
  storageClass: z.string().max(32).optional(), shelfLifeDays: z.number().int().positive().nullish(),
  abcClass: z.string().max(4).nullish(), vedClass: z.string().max(4).nullish(),
  active: z.boolean().optional(),
});
const regulationBody = z.object({
  mrpDefaultPaise: paise.nullish(), mrpUom: z.string().max(32).nullish(),
  ceilingPaise: paise.nullish(), effectiveFrom: z.string().datetime(),
  gazetteRef: z.string().max(200).nullish(),
});

const bankBody = z.object({
  accountNo: z.string().min(4).max(34), ifsc: z.string().min(4).max(16),
  bankName: z.string().max(200).optional(), branch: z.string().max(200).optional(),
  accountHolder: z.string().max(200).optional(),
});
const vendorCreateBody = z.object({
  code, legalName: name, tradeName: z.string().max(200).nullish(),
  gstin: z.string().max(20).nullish(), pan: z.string().max(20).nullish(),
  msmeUdyamNo: z.string().max(32).nullish(), msmeClass: z.string().max(16).nullish(),
  paymentTermsDays: z.number().int().nullish(),
  classFlags: z.record(z.string(), z.boolean()).optional(),
});
const vendorPatchBody = z.object({
  legalName: name.optional(), tradeName: z.string().max(200).nullish(),
  gstin: z.string().max(20).nullish(), pan: z.string().max(20).nullish(),
  msmeUdyamNo: z.string().max(32).nullish(), msmeClass: z.string().max(16).nullish(),
  paymentTermsDays: z.number().int().nullish(),
  classFlags: z.record(z.string(), z.boolean()).optional(),
});
const documentBody = z.object({
  type: z.string().min(1).max(48), number: z.string().min(1).max(64),
  validFrom: dateStr.nullish(), validTo: dateStr.nullish(), fileRef: z.string().max(500).nullish(),
});
const reasonBody = z.object({ reason: z.string().min(1).max(500) });
const blacklistBody = z.object({ reason: z.enum(BLACKLIST_REASONS) });

const storeBody = z.object({
  code, name, parentId: id.nullish(), siteId: z.string().max(32).optional(),
});

const grnLineBody = z.object({
  itemId: id, uom: z.string().min(1).max(32), qtyInUom: z.number().int().positive(),
  batchNo: z.string().max(64).nullish(), mfgDate: dateStr.nullish(), expiryDate: dateStr.nullish(),
  mrpPaise: paise.nullish(), mrpUom: z.string().max(32).nullish(),
  unitCostPaise: paise.nonnegative(), freeGoods: z.boolean().optional(),
  tempLogRef: z.string().max(200).nullish(),
});
const grnCaptureBody = z.object({
  vendorId: id, source: z.enum(["challan", "consignment_challan", "donation"]),
  storeResourceId: id, challanNo: z.string().min(1).max(64), challanDate: dateStr,
  invoiceNo: z.string().max(64).nullish(), poRef: z.string().max(64).nullish(),
  lines: z.array(grnLineBody).min(1).max(200),
});

const issueBody = z.object({
  fromResourceId: id, toResourceId: id, note: z.string().max(500).nullish(),
  lines: z.array(z.object({
    itemId: id, qtyBase: z.number().int().positive(),
    batchId: id.optional(), overrideReason: z.string().max(500).optional(),
  })).min(1).max(200),
});
const receiveBody = z.object({
  lines: z.array(z.object({
    lineId: id, qtyReceived: z.number().int().nonnegative(),
  })).min(1).max(200),
});
const recallBody = z.object({ batchId: id, reason: z.string().min(1).max(500) });

@Controller("materials")
export class MaterialsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ═══════════════════════════════ ITEMS ═══════════════════════════════

  @RequirePermission("materials.items.read", "hospital")
  @Get("items")
  async items(@Query() query: unknown): Promise<{ items: unknown[] }> {
    const q = parsed(z.object({
      class: z.string().max(32).optional(), active: flagQuery, search: z.string().max(200).optional(),
    }), query);
    return {
      items: await listItems(this.db, {
        ...(q.class === undefined ? {} : { class: q.class }),
        ...(q.active === undefined ? {} : { active: q.active === "true" }),
        ...(q.search === undefined ? {} : { search: q.search }),
      }),
    };
  }

  @RequirePermission("materials.items.read", "hospital")
  @Get("items/:id")
  async item(@Param("id") itemId: string): Promise<{ item: unknown }> {
    const item = await getItem(this.db, itemId);
    if (item === undefined) toHttp(new MaterialsError("unknown_item", `item ${itemId} not found`));
    return { item };
  }

  @RequirePermission("materials.items.manage", "hospital")
  @Post("items")
  async createItem(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ itemId: string }> {
    const b = parsed(itemCreateBody, body);
    try {
      return await withTx(this.db, (tx) => registerItem(tx, actor, b));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.items.manage", "hospital")
  @Patch("items/:id")
  async patchItem(
    @CurrentActor() actor: Actor, @Param("id") itemId: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(itemPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateItem(tx, actor, itemId, b));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.items.manage", "hospital")
  @Post("items/:id/uoms")
  async addUom(
    @CurrentActor() actor: Actor, @Param("id") itemId: string, @Body() body: unknown,
  ): Promise<{ itemUomId: string }> {
    const b = parsed(uomInput, body);
    try {
      return await withTx(this.db, (tx) => addItemUom(tx, actor, itemId, b));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.items.manage", "hospital")
  @Post("items/:id/barcodes")
  async addItemBarcode(
    @CurrentActor() actor: Actor, @Param("id") itemId: string, @Body() body: unknown,
  ): Promise<{ barcodeId: string }> {
    const b = parsed(barcodeInput, body);
    try {
      return await withTx(this.db, (tx) => addBarcode(tx, actor, itemId, b));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.items.manage", "hospital")
  @Post("items/:id/regulations")
  async addRegulation(
    @CurrentActor() actor: Actor, @Param("id") itemId: string, @Body() body: unknown,
  ): Promise<{ regulationId: string }> {
    const b = parsed(regulationBody, body);
    try {
      return await withTx(this.db, (tx) => setPriceRegulation(tx, actor, itemId, {
        ...b, effectiveFrom: new Date(b.effectiveFrom),
      }));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.items.read", "hospital")
  @Get("barcodes/:code")
  async barcode(@Param("code") barcodeCode: string): Promise<{ resolved: unknown }> {
    const resolved = await resolveBarcode(this.db, barcodeCode);
    if (resolved === undefined) {
      toHttp(new MaterialsError("unknown_item", `barcode ${barcodeCode} resolves to no item`));
    }
    return { resolved };
  }

  // ═══════════════════════════════ VENDORS ═══════════════════════════════

  @RequirePermission("materials.vendors.read", "hospital")
  @Get("vendors")
  async vendors(@Query() query: unknown): Promise<{ vendors: unknown[] }> {
    const q = parsed(z.object({
      status: z.string().max(32).optional(), search: z.string().max(200).optional(),
    }), query);
    return {
      vendors: await listVendors(this.db, {
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.search === undefined ? {} : { search: q.search }),
      }),
    };
  }

  @RequirePermission("materials.vendors.read", "hospital")
  @Get("vendors/:id")
  async vendor(@Param("id") vendorId: string): Promise<{ vendor: unknown; documents: unknown[] }> {
    const vendor = await getVendor(this.db, vendorId);
    if (vendor === undefined) toHttp(new MaterialsError("unknown_vendor", `vendor ${vendorId} not found`));
    return { vendor, documents: await listVendorDocuments(this.db, vendorId) };
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors")
  async createVendor(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ vendorId: string }> {
    const b = parsed(vendorCreateBody, body);
    try {
      return await withTx(this.db, (tx) => registerVendor(tx, actor, b));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Patch("vendors/:id")
  async patchVendor(
    @CurrentActor() actor: Actor, @Param("id") vendorId: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(vendorPatchBody, body);
    try {
      await withTx(this.db, (tx) => updateVendor(tx, actor, vendorId, b));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors/:id/documents")
  async addDocument(
    @CurrentActor() actor: Actor, @Param("id") vendorId: string, @Body() body: unknown,
  ): Promise<{ documentId: string }> {
    const b = parsed(documentBody, body);
    try {
      return await withTx(this.db, (tx) => addVendorDocument(tx, actor, vendorId, b));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors/:id/activate")
  async activate(@CurrentActor() actor: Actor, @Param("id") vendorId: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => activateVendor(tx, actor, vendorId, new Date()));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors/:id/suspend")
  async suspend(
    @CurrentActor() actor: Actor, @Param("id") vendorId: string, @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const b = parsed(reasonBody, body);
    try {
      await withTx(this.db, (tx) => suspendVendor(tx, actor, vendorId, b.reason));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors/:id/reinstate")
  async reinstate(@CurrentActor() actor: Actor, @Param("id") vendorId: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => reinstateVendor(tx, actor, vendorId, new Date()));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors/:id/blacklist")
  async blacklist(
    @CurrentActor() actor: Actor, @Param("id") vendorId: string, @Body() body: unknown,
  ): Promise<{ blacklistUntil: string }> {
    const b = parsed(blacklistBody, body);
    try {
      const { blacklistUntil } = await withTx(this.db, (tx) =>
        blacklistVendor(tx, actor, vendorId, b.reason as BlacklistReason, new Date()));
      return { blacklistUntil: blacklistUntil.toISOString() };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("vendors/:id/bank-change")
  async bankChange(
    @CurrentActor() actor: Actor, @Param("id") vendorId: string, @Body() body: unknown,
  ): Promise<{ changeId: string; approvalId: string }> {
    const b = parsed(z.object({ bank: bankBody, note: z.string().max(500).optional() }), body);
    try {
      return await withTx(this.db, (tx) => requestBankChange(tx, actor, vendorId, b.bank, b.note));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.vendors.manage", "hospital")
  @Post("bank-changes/:id/apply")
  async applyBank(
    @CurrentActor() actor: Actor, @Param("id") changeId: string,
  ): Promise<{ coolingOffUntil: string }> {
    try {
      const { coolingOffUntil } = await withTx(this.db, (tx) =>
        applyBankChange(tx, actor, changeId, new Date()));
      return { coolingOffUntil: coolingOffUntil.toISOString() };
    } catch (e) { toHttp(e); }
  }

  /** The ONE reader of an unmasked account number, and it is `vendors.manage` (T4's header). */
  @RequirePermission("materials.vendors.manage", "hospital")
  @Get("bank-changes/:id")
  async bankChangeDetail(@Param("id") changeId: string): Promise<{ change: unknown }> {
    const change = await getBankChange(this.db, changeId);
    if (change === undefined) {
      toHttp(new MaterialsError("unknown_document", `bank change ${changeId} not found`));
    }
    return { change };
  }

  @RequirePermission("materials.vendors.read", "hospital")
  @Get("vendors/:id/bank-changes")
  async vendorBankChanges(@Param("id") vendorId: string): Promise<{ changes: unknown[] }> {
    return { changes: await listBankChanges(this.db, vendorId) };
  }

  // ═══════════════════════════════ STORES AND STOCK ═══════════════════════════════

  @RequirePermission("materials.stock.read", "hospital")
  @Get("stores")
  async stores(@Query() query: unknown): Promise<{ stores: unknown[] }> {
    const q = parsed(z.object({ includeTransit: flagQuery, siteId: z.string().max(32).optional() }), query);
    return {
      stores: await listStores(this.db, {
        includeTransit: q.includeTransit === "true",
        ...(q.siteId === undefined ? {} : { siteId: q.siteId }),
      }),
    };
  }

  @RequirePermission("materials.stores.manage", "hospital")
  @Post("stores")
  async createAStore(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ resourceId: string }> {
    const b = parsed(storeBody, body);
    try {
      return await withTx(this.db, (tx) => createStore(tx, actor, b));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get("stock/balances")
  async stockBalances(@Query() query: unknown): Promise<{ balances: unknown[] }> {
    const q = parsed(z.object({
      resourceId: id.optional(), itemId: id.optional(), batchId: id.optional(),
    }), query);
    return { balances: await balances(this.db, q) };
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get("stock/movements")
  async stockMovements(@Query() query: unknown): Promise<{ movements: unknown[] }> {
    const q = parsed(z.object({
      batchId: id.optional(), resourceId: id.optional(), itemId: id.optional(),
      limit: z.string().regex(/^\d+$/).optional(),
    }), query);
    const { limit, ...filter } = q;
    return {
      movements: await movementsFor(this.db, filter, {
        ...(limit === undefined ? {} : { limit: Math.min(Number(limit), 500) }),
      }),
    };
  }

  /** DD14's worklist. A read route, not an alert — see `expiry.ts`'s header. */
  @RequirePermission("materials.stock.read", "hospital")
  @Get("expiring")
  async expiring(@Query() query: unknown): Promise<{ batches: unknown[] }> {
    const q = parsed(z.object({ withinDays: z.string().regex(/^\d+$/).optional() }), query);
    return {
      batches: await expiringBatches(
        this.db, new Date(),
        q.withinDays === undefined ? undefined : Math.min(Number(q.withinDays), 365),
      ),
    };
  }

  @RequirePermission("materials.recall.manage", "hospital")
  @Post("recalls")
  async recall(
    @CurrentActor() actor: Actor, @Body() body: unknown,
  ): Promise<{ locations: { storeResourceId: string; qtyFrozen: number }[] }> {
    const b = parsed(recallBody, body);
    try {
      return await withTx(this.db, (tx) => recallBatch(tx, actor, b.batchId, b.reason));
    } catch (e) { toHttp(e); }
  }

  // ═══════════════════════════════ THE GRN GATE ═══════════════════════════════

  /**
   * ═══ CLOSE REVIEW M6 — THE READ HALF OF DD8's GATE IS GUARDED ON `stock.read`, NOT `grn.capture`
   *     ═══
   *
   * DD11 makes the **pharmacist the QC signatory for drugs**, and `seed-roles.ts` grants `pharmacy`
   * exactly `items.read`, `stock.read` and `grn.qc` — deliberately **not** `grn.capture`, because
   * capture is the storekeeper's half of the two-stage gate.
   *
   * These two READ routes were guarded on `materials.grn.capture`. So the one role the plan names
   * as the QC signatory **could post a verdict it was not allowed to read the GRN to reach**: 403
   * on the list, 403 on the detail, `POST grns/:id/qc` wide open. A signatory who cannot see the
   * document is not a signatory, and the grant DD11 rules was unreachable in practice.
   *
   * `materials.stock.read` is the right guard and `seed-roles.ts` had already said so in a comment
   * beside the grant — *"`materials.stock.read` is what makes a QC verdict informed"*. All three
   * roles that touch a GRN hold it (`materials_head`, `storekeeper`, `pharmacy`), so this WIDENS
   * nobody's authority beyond what DD11 already granted; it stops narrowing it below.
   *
   * The WRITE routes are untouched: `POST grns` stays on `grn.capture` and the three verdict routes
   * stay on `grn.qc`. Reading a GRN and acting on it remain separate authorities.
   */
  @RequirePermission("materials.stock.read", "hospital")
  @Get("grns")
  async grns(@Query() query: unknown): Promise<{ grns: unknown[] }> {
    const q = parsed(z.object({
      vendorId: id.optional(), storeResourceId: id.optional(), status: z.string().max(32).optional(),
    }), query);
    return { grns: await listGrns(this.db, q) };
  }

  /** M6 — see `grns()` above: the QC signatory must be able to read what it signs. */
  @RequirePermission("materials.stock.read", "hospital")
  @Get("grns/:id")
  async grn(@Param("id") grnId: string): Promise<{ grn: unknown }> {
    const grn = await getGrn(this.db, grnId);
    if (grn === undefined) toHttp(new MaterialsError("unknown_document", `GRN ${grnId} not found`));
    return { grn };
  }

  @RequirePermission("materials.grn.capture", "hospital")
  @Post("grns")
  async capture(
    @CurrentActor() actor: Actor, @Body() body: unknown,
  ): Promise<{ grnId: string; grnNo: string }> {
    const b = parsed(grnCaptureBody, body);
    try {
      return await withTx(this.db, (tx) => captureGrn(tx, actor, { ...b, now: new Date() }));
    } catch (e) { toHttp(e); }
  }

  /** DD8's second stage, and its own permission — the storekeeper does not sign the verdict. */
  @RequirePermission("materials.grn.qc", "hospital")
  @Post("grns/:id/qc")
  async qc(
    @CurrentActor() actor: Actor, @Param("id") grnId: string,
  ): Promise<{ status: string; verdicts: unknown[] }> {
    try {
      return await withTx(this.db, (tx) => runGateQc(tx, actor, grnId));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.grn.qc", "hospital")
  @Post("grns/:id/near-expiry-request")
  async nearExpiry(
    @CurrentActor() actor: Actor, @Param("id") grnId: string, @Body() body: unknown,
  ): Promise<{ approvalId: string }> {
    const b = parsed(z.object({ note: z.string().max(500).optional() }), body);
    try {
      return await withTx(this.db, (tx) => requestNearExpiryAcceptance(tx, actor, grnId, b.note));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.grn.qc", "hospital")
  @Post("grns/:id/post")
  async post(
    @CurrentActor() actor: Actor, @Param("id") grnId: string,
  ): Promise<{ status: string; ledgerEntryIds: string[] }> {
    try {
      return await withTx(this.db, (tx) => postGrn(tx, actor, grnId, new Date()));
    } catch (e) { toHttp(e); }
  }

  // ═══════════════════════════════ TRANSFERS ═══════════════════════════════

  @RequirePermission("materials.stock.read", "hospital")
  @Get("transfers")
  async transfers(@Query() query: unknown): Promise<{ transfers: unknown[] }> {
    const q = parsed(z.object({
      status: z.string().max(32).optional(), fromResourceId: id.optional(), toResourceId: id.optional(),
    }), query);
    return { transfers: await listTransfers(this.db, q) };
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get("transfers/discrepancies")
  async discrepancies(): Promise<{ transfers: unknown[] }> {
    return { transfers: await listDiscrepancies(this.db) };
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get("transfers/:id")
  async transfer(@Param("id") transferId: string): Promise<{ transfer: unknown }> {
    const transfer = await getTransfer(this.db, transferId);
    if (transfer === undefined) {
      toHttp(new MaterialsError("unknown_document", `transfer ${transferId} not found`));
    }
    return { transfer };
  }

  @RequirePermission("materials.stock.issue", "hospital")
  @Post("transfers")
  async issue(
    @CurrentActor() actor: Actor, @Body() body: unknown,
  ): Promise<{ transferId: string; lines: unknown[] }> {
    const b = parsed(issueBody, body);
    try {
      return await withTx(this.db, (tx) => issueStock(tx, actor, { ...b, occurredAt: new Date() }));
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.stock.receive", "hospital")
  @Post("transfers/:id/receive")
  async receive(
    @CurrentActor() actor: Actor, @Param("id") transferId: string, @Body() body: unknown,
  ): Promise<{ status: string; shortfalls: unknown[] }> {
    const b = parsed(receiveBody, body);
    try {
      return await withTx(this.db, (tx) => receiveStock(tx, actor, transferId, b.lines, new Date()));
    } catch (e) { toHttp(e); }
  }

  // ═══════════════════════════════ CONSUMPTIONS (DD13's read) ═══════════════════════════════

  /**
   * The read Plan 15 composes a discharge bill from. Guarded on `stock.read` rather than a billing
   * permission: what it returns is stock history, and the money decision is billing's.
   */
  @RequirePermission("materials.stock.read", "hospital")
  @Get("consumptions")
  async consumptions(@Query() query: unknown): Promise<{ consumptions: unknown[] }> {
    const q = parsed(z.object({ encounterId: id }), query);
    return { consumptions: await consumptionsFor(this.db, q.encounterId) };
  }
}
