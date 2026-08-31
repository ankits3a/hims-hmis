import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { autoSlotWalkIn, cancelStudy, deviceDiary, markNoShow, rescheduleStudy, scheduleStudy } from "./schedule";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 18a T4 — **THE IMAGING DIARY OVER HTTP.**
 *
 * Booking, moving, the walk-in auto-slot, the no-show and the cancel. Five routes and one read.
 *
 * ═══ NO `withIdempotency` ON THESE, AND THE REASON IS THE SLOT INDEX ═══
 *
 * T3's placement route needs an idempotency claim because a retried click would mint a second `R`
 * number and a second study. These routes do not, because the thing a retry would duplicate is
 * already impossible: `imaging_studies_slot_ux` refuses a second live booking on the same device
 * and instant, so a double-submitted booking is `slot_taken` rather than two appointments. Adding a
 * claim would be a second mechanism guarding a property the database already holds.
 *
 * `cancel` and `no-show` are idempotent by their own state machines — a second cancel of a
 * cancelled study is `bad_transition`, which is the honest answer rather than a silent success.
 */
const scheduleBody = z.object({
  deviceResourceId: idSchema,
  /** An ISO instant. The caller resolves the clock; a route that took a date and a time would be
   *  a second place that knows about IST. */
  scheduledAt: z.string().datetime(),
});

const cancelBody = z.object({
  reason: z.string().min(1).max(400).nullish(),
});

@Controller("radiology/studies")
export class RadiologyScheduleController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  private decls() { return collectOrderKinds(this.registry); }

  @Post(":studyId/schedule")
  @RequirePermission("radiology.schedule", "hospital")
  async schedule(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(scheduleBody, body);
    try {
      return await withTx(this.db, (tx) => scheduleStudy(tx, actor, {
        studyId, deviceResourceId: input.deviceResourceId, scheduledAt: new Date(input.scheduledAt),
      }));
    } catch (e) { toHttp(e); }
  }

  @Post(":studyId/reschedule")
  @RequirePermission("radiology.schedule", "hospital")
  async reschedule(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(scheduleBody, body);
    try {
      return await withTx(this.db, (tx) => rescheduleStudy(tx, actor, {
        studyId, deviceResourceId: input.deviceResourceId, scheduledAt: new Date(input.scheduledAt),
      }));
    } catch (e) { toHttp(e); }
  }

  /** The counter's walk-in: the first free machine of the right modality, now. */
  @Post(":studyId/walk-in")
  @RequirePermission("radiology.schedule", "hospital")
  async walkIn(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
  ): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => autoSlotWalkIn(tx, actor, { studyId }));
    } catch (e) { toHttp(e); }
  }

  @Post(":studyId/no-show")
  @RequirePermission("radiology.schedule", "hospital")
  async noShow(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
  ): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => markNoShow(tx, actor, studyId));
    } catch (e) { toHttp(e); }
  }

  /**
   * A4 — the cancel. `radiology.schedule` rather than a cancel permission of its own: DD16's role
   * sketch left `orders.cancel` NOT_YET_MODELLED with its reason amended to name this phase's own
   * permission, and cancelling a booking is the same desk act as moving one. `advanceOrderItem`
   * inside applies the kernel's own rules on top.
   */
  @Post(":studyId/cancel")
  @RequirePermission("radiology.schedule", "hospital")
  async cancel(
    @CurrentActor() actor: Actor,
    @Param("studyId") studyId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(cancelBody, body);
    try {
      return await withTx(this.db, (tx) => cancelStudy(tx, actor, this.decls(), {
        studyId, reason: input.reason ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  /** The machine's live diary — what the console shows when a technologist opens a device. */
  @Get("device/:deviceResourceId/diary")
  @RequirePermission("radiology.worklist.read", "hospital")
  async diary(@Param("deviceResourceId") deviceResourceId: string): Promise<unknown> {
    try {
      return { studies: await deviceDiary(this.db, deviceResourceId) };
    } catch (e) { toHttp(e); }
  }
}
