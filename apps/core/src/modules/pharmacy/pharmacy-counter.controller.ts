import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CONFIG, DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { withIdempotency } from "../billing";
import { claimDispense, findAtCounter } from "./claim";
import { istDateOf } from "./config";
import { PHARMACY_IDEMPOTENT_ROUTES, idSchema, parsed, toHttp } from "./pharmacy-http";
import { confirmSlip, getDispense, listQueue } from "./queue";
import { billDispense, previewDispenseBill } from "./bill";
import { handOverDispense } from "./handover";
import { labelFor } from "./label";
import { pickDispense } from "./pick";
import { alternativesFor, cancelDispense, declineLine, verifyDispense } from "./verify";
import { cancelBilledDispense } from "./refund";
import { reorderAdvice } from "./replenishment";
import type { ReorderAdvice } from "./replenishment";
import type { CancelBilledResult } from "./refund";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";
import type { FindResult } from "./claim";
import type { DispenseView, QueueRow } from "./queue";
import type { Alternative } from "./verify";
import type { PricedDraft } from "../billing";
import type { LabelData } from "./label";

const claimBody = z.object({ dispenseId: idSchema, door: z.enum(["rx_qr", "patient_qr", "token", "uhid"]) });
const verifyBody = z.object({
  lines: z.array(z.object({
    lineIdx: z.number().int().nonnegative(),
    qtyBase: z.number().int().positive(),
    dispensedMedicineId: idSchema.optional(),
    patientConsent: z.boolean().optional(),
  })),
});
const reasonBody = z.object({ reason: z.string().min(1).max(240) });
const refundBody = z.object({ reason: z.string().min(3).max(500), reasonClass: z.enum(["mistake", "genuine"]) });
const pickBody = z.object({
  lines: z.array(z.object({
    lineIdx: z.number().int().nonnegative(),
    qtyBase: z.number().int().positive().optional(),
    pickNote: z.string().max(240).optional(),
    batchId: idSchema.optional(),
  })).optional(),
});
const billBody = z.object({
  tenders: z.array(z.object({ mode: z.enum(["cash", "upi", "card"]), amountPaise: z.number().int().nonnegative(), refText: z.string().max(120).optional() })).min(1),
  panNumber: z.string().max(20).optional(),
  form60: z.boolean().optional(),
  changeGivenPaise: z.number().int().nonnegative().optional(),
  tags: z.array(z.string().min(1)).optional(),
});
const handoverBody = z.object({
  identity: z.object({ via: z.enum(["token", "phone_last4"]), value: z.string().min(1).max(12) }).optional(),
});

/**
 * PLAN 16c T3 — the counter's routes. `decls` come from the INSTALLED registry (17a F2), the
 * idempotency claim wraps the transaction rather than living inside it (the lab desk's shape),
 * and every route is gated by `@RequirePermission` alone.
 */
@Controller("pharmacy")
export class PharmacyCounterController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  private decls() { return collectOrderKinds(this.registry); }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("queue")
  async queue(@CurrentActor() actor: Actor, @Query("serviceDate") serviceDate?: string): Promise<{ items: QueueRow[] }> {
    return { items: await listQueue(this.db, actor, { serviceDate: serviceDate ?? istDateOf(new Date()) }) };
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("find")
  async find(@CurrentActor() actor: Actor, @Query("q") q?: string): Promise<FindResult> {
    try {
      return await findAtCounter(this.db, this.cfg, actor, q ?? "", new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id")
  async one(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<DispenseView> {
    try {
      return await getDispense(this.db, actor, id);
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id/lines/:idx/alternatives")
  async alternatives(@Param("id") id: string, @Param("idx") idx: string): Promise<{ items: Alternative[] }> {
    try {
      return { items: await alternativesFor(this.db, id, Number(idx)) };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses")
  async claim(@CurrentActor() actor: Actor, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(claimBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.claim, key }, input,
        () => claimDispense(this.db, actor, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/verify")
  async verify(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(verifyBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.verify, key }, { id, ...input },
        () => verifyDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/pick")
  async pick(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(pickBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.pick, key }, { id, ...input },
        () => pickDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * ═══ FD-31 — THE PHARMACIST'S CROSS-CONFIRMATION (OWNER RULING 2026-09-12) ═══
   *
   * `pharmacy.dispense.place` — the counter's own key, which the pharmacist working the queue
   * already holds. Deliberately NOT `pharmacy.dispense.scheduled`: that is the registered
   * pharmacist's hand-over grant for Schedule H, and gating this on it would mean an ordinary
   * transcribed slip could not be confirmed by the person actually at the window.
   *
   * No body. The attestation is "I have the slip and it matches"; anything this route asked the
   * pharmacist to type would be a second-hand copy of what the slip already says.
   */
  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/confirm-slip")
  async confirmSlipRoute(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ slipConfirmedBy: string | null; slipConfirmedAt: Date | null }> {
    try {
      const row = await confirmSlip(this.db, actor, id, new Date());
      return { slipConfirmedBy: row.slipConfirmedBy, slipConfirmedAt: row.slipConfirmedAt };
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Get("dispenses/:id/bill/preview")
  async preview(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<PricedDraft> {
    try {
      return await previewDispenseBill(this.db, actor, id, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.issue", "hospital")
  @Post("dispenses/:id/bill")
  async bill(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(billBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.bill, key }, { id, ...input },
        () => billDispense(this.db, actor, id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/handover")
  async handover(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<DispenseView> {
    const input = parsed(handoverBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.handover, key }, { id, ...input },
        () => handOverDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("dispenses/:id/label")
  async label(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<LabelData> {
    try {
      return await labelFor(this.db, actor, id);
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/lines/:idx/decline")
  async decline(@CurrentActor() actor: Actor, @Param("id") id: string, @Param("idx") idx: string, @Body() body: unknown): Promise<DispenseView> {
    const { reason } = parsed(reasonBody, body);
    try {
      return await declineLine(this.db, actor, this.decls(), id, Number(idx), reason, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /** P4 — the reorder list: what the counter will run out of, and where it can come from. Read-only. */
  @RequirePermission("pharmacy.dispense.read", "hospital")
  @Get("reorder")
  async reorder(): Promise<ReorderAdvice> {
    try {
      return await reorderAdvice(this.db, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }

  /**
   * P5 — a paid dispense that cannot be collected. The act asserts the Act's registration and both
   * billing strings itself; this decorator is the first gate, not the only one.
   */
  @RequirePermission("billing.refund.request", "hospital")
  @Post("dispenses/:id/refund")
  async refund(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string): Promise<CancelBilledResult> {
    const input = parsed(refundBody, body);
    try {
      return await withIdempotency(this.db, { actorId: actor.id, route: PHARMACY_IDEMPOTENT_ROUTES.refund, key }, { id, ...input },
        () => cancelBilledDispense(this.db, actor, this.decls(), id, input, new Date()));
    } catch (e) {
      return toHttp(e);
    }
  }

  @RequirePermission("pharmacy.dispense.place", "hospital")
  @Post("dispenses/:id/cancel")
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<DispenseView> {
    const { reason } = parsed(reasonBody, body);
    try {
      return await cancelDispense(this.db, actor, this.decls(), id, reason, new Date());
    } catch (e) {
      return toHttp(e);
    }
  }
}
