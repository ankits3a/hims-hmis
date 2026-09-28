import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { addImagingViews, placeImagingOrder } from "./place";
import { imagingDoorFor } from "./advised";
import { idSchema, isoDateSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";
import type { PlaceImagingOrderInput } from "./place";

/**
 * PLAN 18a T3 — **PLACING AN IMAGING ORDER OVER HTTP.**
 *
 * ═══ EVERY FIELD THE SERVICE READS IS NAMED IN THE SCHEMA, AND THAT IS 22c-A's C1 ═══
 *
 * 22c-A shipped a route whose zod schema omitted a field its service needed: the request returned
 * **200 and wrote nothing**, and every test in that phase had called the service directly. So the
 * schema below names every field `placeImagingOrder` reads, and the e2e asserts the ROW each route
 * wrote rather than its status code.
 *
 * ═══ IDEMPOTENCY IS INSIDE THE SERVICE, NOT AROUND IT — AND THAT DIFFERS FROM THE LAB ═══
 *
 * `lab-desk.controller.ts` wraps `deskOrder` in `withIdempotency` at the ROUTE, because `deskOrder`
 * takes a `tx` and has no `Db` of its own. `placeImagingOrder` takes a `Db` and owns its claim, so
 * wrapping it again here would take TWO claims for one request against the same
 * `(actorId, route, key)` — the second would see the first `in_progress` and replay a response that
 * does not exist yet. The claim belongs wherever the transaction is opened, and for this module
 * that is the service.
 */
const itemSchema = z.object({
  serviceId: idSchema,
  /** DD10b — the pair that overrides the 24-hour window. Both or neither; the CHECK refuses a half. */
  duplicateOfItemId: idSchema.nullish(),
  duplicateReason: z.string().min(1).max(400).nullish(),
  parentItemId: idSchema.nullish(),
  /**
   * 18-S RS2b — the ward and bed, for a study the machine goes to. Carried to the service, which
   * trims it and owns the refusal (`invalid_bedside_location`); the bound here only caps the body.
   */
  bedsideLocation: z.string().max(400).nullish(),
});

const orderBody = z.object({
  patientId: idSchema,
  encounterNo: z.string().min(1).max(32),
  serviceDate: isoDateSchema,
  orderingClinicianId: idSchema,
  orderGroupId: idSchema.optional(),
  priority: z.enum(["routine", "urgent", "stat"]).optional(),
  /**
   * `radiologyManifest` declares `requiresIndication: true`, so the kernel refuses an order with no
   * reason. It is `.min(1)` here as well rather than left to the kernel — a counter that typed a
   * space should be told at the wire, and a CT with no stated indication is a dose nobody can
   * justify to an AERB inspector.
   */
  indication: z.string().min(1).max(500),
  items: z.array(itemSchema).min(1),
  /** DD9's walk-in leg: an outside slip places under `external_prescription` with a referrer. */
  authority: z.enum(["clinician", "external_prescription"]).optional(),
  externalReferrerId: idSchema.nullish(),
  /** 18-S RS2 — the slip's referrer, typed at the desk; `place.ts` finds or makes the counterparty. */
  referrer: z.object({
    name: z.string().trim().min(1).max(200),
    registrationNo: z.string().trim().min(1).max(64),
  }).nullish(),
});

/**
 * An outside slip names its doctor: an `external_prescription` without a referrer id or the typed
 * name + registration is refused at the wire rather than as a raw CHECK violation in the kernel.
 */
const referrerRule = (b: { authority?: string; externalReferrerId?: string | null; referrer?: unknown }) =>
  b.authority !== "external_prescription" || (b.externalReferrerId ?? null) !== null || (b.referrer ?? null) !== null;
const referrerMessage = { message: "an outside prescription needs the referrer's name and registration number", path: ["referrer"] };

const placeBody = orderBody.refine(referrerRule, referrerMessage);

/** The add-on inherits the parent's group; naming a group here would let a caller re-parent it. */
const addViewsBody = orderBody.omit({ orderGroupId: true }).refine(referrerRule, referrerMessage);

const advisedQuery = z.object({ encounterNo: z.string().trim().min(1).max(32) });

@Controller("radiology")
export class RadiologyOrdersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  /**
   * `collectOrderKinds` off the INSTALLED registry, per request, rather than a module-level
   * constant assigned at boot. `kernel/orders/place.ts`'s header argues it at length: a mutable
   * global makes every test either a boot or a lie, and a stale copy goes wrong without a
   * typecheck error.
   */
  private decls() { return collectOrderKinds(this.registry); }

  /**
   * 18-S RS2 (18a-iv T1) — THE ORDERING DOOR'S READ: a visit's advised imaging lines against the
   * active book, the book itself with prices, the 30-day look-back and the visit's standing imaging
   * orders. ONE route for both seats that place — the consult and the imaging desk — so it is
   * guarded on the permission both hold, `radiology.orders.place`: the doctor holds neither
   * `radiology.schedule` nor `radiology.definitions.read`, and a second route over the same reader
   * would be two answers to one question. PHI-logged as `opd.visit`, as the lab desk's is.
   */
  @Get("advised")
  @RequirePermission("radiology.orders.place", "hospital")
  async advised(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<unknown> {
    const { encounterNo } = parsed(advisedQuery, query);
    try {
      return await imagingDoorFor(this.db, actor, encounterNo);
    } catch (e) { toHttp(e); }
  }

  @Post("orders")
  @RequirePermission("radiology.orders.place", "hospital")
  async place(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(placeBody, body);
    try {
      return await placeImagingOrder(
        this.db, actor, this.decls(), input as unknown as PlaceImagingOrderInput, key,
      );
    } catch (e) { toHttp(e); }
  }

  /**
   * DD10c / A5 — THE ADD-ON IS A NEW ORDER IN THE PARENT'S GROUP, never a row appended to the
   * parent's items. The route reads the parent only to inherit `order_group_id`; the parent's
   * header and items are not written to at all.
   */
  @Post("orders/:orderId/items")
  @RequirePermission("radiology.orders.place", "hospital")
  async addViews(
    @CurrentActor() actor: Actor,
    @Param("orderId") orderId: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(addViewsBody, body);
    try {
      return await addImagingViews(
        this.db, actor, this.decls(), orderId, input as unknown as PlaceImagingOrderInput, key,
      );
    } catch (e) { toHttp(e); }
  }
}
