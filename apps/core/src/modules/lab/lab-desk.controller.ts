import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { listOrdersForEncounter, listOrdersForPatient } from "../../kernel/orders/read";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { previewInvoice, withIdempotency } from "../billing";
import { addOnOrder, deskFind, labDoctors, tubePlan } from "./desk";
import { cancelLabItem, deskOrderAtCounter } from "./money";
import { idSchema, isoDateSchema, LAB_IDEMPOTENT_ROUTES, parsed, toHttp } from "./lab-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";
import type { DeskOrderInput, DeskWalkinInput } from "./desk";

/**
 * PLAN 17b T8 — **THE LAB DESK OVER HTTP**: what a doctor advised becomes an order and an invoice.
 *
 * ═══ THE WIRE SCHEMA IS THE GATE, AND 22c-A's C1 IS WHY THIS FILE IS PARANOID ABOUT IT ═══
 *
 * 22c-A shipped a route whose zod schema omitted a field the service needed: the request returned
 * **200 and wrote nothing**, and every test in the phase had called the service directly. So every
 * field `deskOrder` reads is named below, `lab.e2e.test.ts` asserts the BODY each route WROTE
 * rather than its status, and a field that stops crossing this wire fails a test instead of
 * silently vanishing.
 *
 * ═══ IDEMPOTENCY IS ON THE ROUTE, AROUND THE TRANSACTION — NEVER INSIDE IT (DD19/DD22) ═══
 *
 * A claim taken inside the transaction it is meant to arbitrate rolls back with it and protects
 * nothing. `withIdempotency(db, scope, body, work)` takes the claim first and the work runs inside
 * the closure, which is `billing.controller.ts`'s own shape.
 */
const consentSchema = z.object({ recordedBy: z.string().min(1).max(120) });
const itemSchema = z.object({
  serviceId: idSchema,
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  consent: consentSchema.optional(),
  collectionSite: z.enum(["opd", "ward", "home", "camp", "external"]).optional(),
});
const tenderSchema = z.object({
  mode: z.enum(["cash", "card", "upi", "netbanking", "cheque", "wallet"]),
  amountPaise: z.number().int().positive(),
  reference: z.string().max(64).optional(),
});
/**
 * PLAN 17c T1 — the walk-in door. `encounterNo` OR `walkIn`, never both and never neither: a
 * walk-in with an outside prescription has no visit yet, and `deskWalkinOrder` opens one in the
 * same transaction as the order (17a A9's `openLabWalkin`, which shipped with no caller).
 */
const walkInSchema = z.object({
  referrerName: z.string().max(160).optional(),
  doctorId: idSchema.optional(),
  intendedPayer: z.enum(["self", "tpa", "pmjay", "corporate"]).optional(),
});
const orderBody = z.object({
  patientId: idSchema,
  encounterNo: z.string().min(1).max(32).optional(),
  walkIn: walkInSchema.optional(),
  serviceDate: isoDateSchema,
  orderingClinicianId: idSchema.optional(),
  orderGroupId: idSchema.optional(),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  items: z.array(itemSchema).min(1),
  reflexConsent: z.boolean().optional(),
  acknowledgedDuplicates: z.array(idSchema).optional(),
  /** DD15 — a walk-in with an outside slip. The union mirrors `DeskOrderInput`'s exactly. */
  authority: z.enum(["clinician", "external_prescription"]).optional(),
  externalReferrerId: idSchema.nullish(),
  referrerName: z.string().max(160).nullish(),
  attributionConfirmed: z.boolean().optional(),
  receipt: z.object({
    tenders: z.array(tenderSchema).min(1),
    panNumber: z.string().max(20).optional(),
    form60: z.boolean().optional(),
    changeGivenPaise: z.number().int().nonnegative().optional(),
  }).optional(),
  credit: z.object({ reason: z.string().min(1).max(200), approvalId: idSchema.optional() }).optional(),
}).refine(
  (b) => (b.encounterNo === undefined) !== (b.walkIn === undefined),
  { message: "exactly one of encounterNo or walkIn" },
).refine(
  (b) => b.walkIn !== undefined || b.orderingClinicianId !== undefined,
  { message: "orderingClinicianId is required on a visit order" },
);
const addOnBody = z.object({
  parentItemId: idSchema,
  serviceIds: z.array(idSchema).min(1),
  specimenId: idSchema.optional(),
  orderingClinicianId: idSchema,
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  credit: z.object({ reason: z.string().min(1).max(200), approvalId: idSchema.optional() }).optional(),
});
const cancelBody = z.object({ reason: z.string().min(1).max(300) });
const findQuery = z.object({ q: z.string().max(80), serviceDate: isoDateSchema });
const previewBody = z.object({
  patientId: idSchema,
  /** 17c T1 — absent for a walk-in that has no visit yet: billing prices it as self-pay. */
  encounterNo: z.string().min(1).max(32).optional(),
  serviceIds: z.array(idSchema).min(1),
});

@Controller("lab/desk")
export class LabDeskController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  /**
   * ═══ `decls` FROM THE **INSTALLED** REGISTRY, NEVER FROM `ALL_MANIFESTS` ═══
   *
   * `placeOrder` and `advanceOrderItem` validate against the declarations of the manifests THIS
   * PROCESS installed (17a F2, and `kinds.ts`'s own header on why it is a parameter rather than a
   * global). The API and the worker install different sets — `sweepLabNonReturn` takes `decls` for
   * exactly this reason — so a controller reading the full catalogue of manifests would validate
   * against kinds its own process never mounted.
   */
  private decls() { return collectOrderKinds(this.registry); }

  @Post("orders")
  @RequirePermission("lab.desk.operate", "hospital")
  async place(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(orderBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.deskOrder, key },
        input,
        () => deskOrderAtCounter(this.db, actor, this.decls(), input as unknown as DeskOrderInput | DeskWalkinInput),
      );
    } catch (e) { toHttp(e); }
  }

  /** DD9 — an add-on is a NEW ORDER in the same group, never a row appended to the parent. */
  @Post("add-on")
  @RequirePermission("lab.desk.operate", "hospital")
  async addOn(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(addOnBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.addOn, key },
        input,
        () => withTx(this.db, (tx) => addOnOrder(tx, actor, this.decls(), input)),
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * DD7 — THE CANCEL AND ITS REFUND ARE ONE ATOM. `cancelLabItem` gates on `orders.cancel` itself
   * (`advanceOrderItem` deliberately gates no `user` actor), so this route's `@RequirePermission`
   * and that check are two independent enforcements of one rule rather than a duplicate.
   */
  @Post("items/:itemId/cancel")
  @RequirePermission("orders.cancel", "hospital")
  async cancel(
    @CurrentActor() actor: Actor,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(cancelBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.cancelItem, key },
        { itemId, ...input },
        () => withTx(this.db, (tx) => cancelLabItem(tx, actor, this.decls(), {
          orderItemId: itemId, reason: input.reason,
        })),
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * ═══ WHAT THIS BASKET COSTS, BEFORE THE COUNTER ASKS FOR MONEY (close review, web C4) ═══
   *
   * The desk screen shipped sending `credit: { reason }` on EVERY order, because it had no way to
   * know the price — so every lab order became an unpaid credit invoice and the delivery interlock
   * then held EVERY report for money that was already in the drawer. A control that fires on 100%
   * of reports is a control a counter learns to release without reading.
   *
   * It goes through billing's OWN `previewInvoice`, which is the same pricing the issue path runs
   * (`priceDraftWithBenefits`), so the number the clerk quotes and the number the invoice charges
   * cannot disagree. A desk that totalled the basket itself would be the second answer §2.54 exists
   * to stop, with the patient's bill as the fact that drifts.
   */
  @Post("preview")
  @RequirePermission("lab.desk.operate", "hospital")
  async preview(@Body() body: unknown): Promise<unknown> {
    const input = parsed(previewBody, body);
    try {
      const priced = await previewInvoice(this.db, {
        patientId: input.patientId,
        encounterId: input.encounterNo,
        lines: input.serviceIds.map((serviceId, i) => ({ lineId: `preview-${String(i)}`, serviceId, qty: 1 })),
      });
      /** 17c T1 — the price and the tubes are one question at the counter: "what am I placing?" */
      return { ...priced, tubes: await tubePlan(this.db, input.serviceIds) };
    } catch (e) { toHttp(e); }
  }

  /**
   * "WHAT HAS BEEN ORDERED FOR THIS PERSON" — the kernel's cross-kind reader, which LOGS the PHI
   * access itself (`orders.patient`). The lab does not re-implement it and does not log again: two
   * rows for one read would make the log answer "what did they see" wrong in the other direction.
   */
  /**
   * PLAN 17c T1 / D4 — ONE FIELD, THREE DOORS. Gated on the desk permission, not the worklist's:
   * it returns the Rx lines of a visit, which is the desk's business and nobody else's.
   */
  @Get("find")
  @RequirePermission("lab.desk.operate", "hospital")
  async find(
    @CurrentActor() actor: Actor,
    @Query("q") q?: string,
    @Query("serviceDate") serviceDate?: string,
  ): Promise<unknown> {
    const input = parsed(findQuery, { q: q ?? "", serviceDate });
    try {
      return { hits: await deskFind(this.db, actor, input.q, input.serviceDate), labDoctors: await labDoctors(this.db) };
    } catch (e) { toHttp(e); }
  }

  @Get("orders")
  @RequirePermission("lab.worklist.read", "hospital")
  async orders(
    @CurrentActor() actor: Actor,
    @Query("patientId") patientId?: string,
    @Query("encounterNo") encounterNo?: string,
  ): Promise<unknown> {
    try {
      if (encounterNo) return await listOrdersForEncounter(this.db, actor, encounterNo);
      if (patientId) return await listOrdersForPatient(this.db, actor, patientId);
      return { orders: [], patientDisplayName: "—" };
    } catch (e) { toHttp(e); }
  }
}
