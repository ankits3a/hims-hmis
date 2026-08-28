import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import {
  admitToBay, convertToAdmission, dischargeDaycare, evaluateDischargeReady, markAbsconded,
  recordScore, recoveryBoard, scoresFor, verifyEscort,
} from "./recovery";
import { composeDischargeBill, settleDischargeBill, unbilledDaycare } from "./bill";
import { idSchema, parsed, toHttp } from "./ot-definitions.controller";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T8 — part 4: recovery and the discharge bill.
 *
 * **`ot.discharge` and `ot.bill.compose` are different permissions on different routes**, which is
 * DD14's third separation and the money one: the recovery nurse who signs a patient out cannot
 * compose her bill, and the billing manager who composes it never touched the bay.
 */
const escortBody = z.object({
  at: z.enum(["checkin", "discharge"]),
  escort: z.object({
    name: z.string().min(1).max(120), relation: z.string().min(1).max(64),
    phone: z.string().min(1).max(20), idType: z.string().min(1).max(32),
    idLast4: z.string().min(1).max(8), ageYears: z.number().int().min(0).max(120),
    escortPatientId: idSchema.optional(), notifyOk: z.boolean().optional(),
  }),
});
const scoreBody = z.object({
  caseId: idSchema,
  values: z.record(z.string().min(1), z.number().int().min(0)),
  occurredAt: z.string().min(1).optional(),
});

@Controller("ot/recovery")
export class OtRecoveryController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission("ot.recovery.operate", "hospital")
  async board(@CurrentActor() actor: Actor): Promise<unknown> {
    // The ACTOR decides which patient names this board may carry (F20).
    try { return await recoveryBoard(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get(":encounterId/scores")
  @RequirePermission("ot.recovery.operate", "hospital")
  async scores(@Param("encounterId") encounterId: string): Promise<unknown> {
    try { return await scoresFor(this.db, encounterId); } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/admit")
  @RequirePermission("ot.recovery.operate", "hospital")
  async admit(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({ bayResourceId: idSchema }), body);
    try { await admitToBay(this.db, actor, { encounterId, ...input }); return { ok: true }; } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/scores")
  @RequirePermission("ot.recovery.operate", "hospital")
  async score(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(scoreBody, body);
    try {
      const recorded = await recordScore(this.db, actor, {
        encounterId, caseId: input.caseId, values: input.values,
        ...(input.occurredAt !== undefined ? { occurredAt: new Date(input.occurredAt) } : {}),
      });
      // Readiness is evaluated after every score, for the reason the satisfy route evaluates it
      // after every gate: the screen does not know which score was the qualifying one.
      const readiness = await evaluateDischargeReady(this.db, { encounterId, caseId: input.caseId });
      return { ...recorded, readiness };
    } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/escort")
  @RequirePermission("ot.recovery.operate", "hospital")
  async escort(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(escortBody, body);
    try { await verifyEscort(this.db, actor, { encounterId, ...input }); return { ok: true }; } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/discharge")
  @RequirePermission("ot.discharge", "hospital")
  async discharge(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({ caseId: idSchema, isbarAcknowledgedBy: z.string().min(1).max(120) }), body);
    try { return await dischargeDaycare(this.db, actor, { encounterId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/convert")
  @RequirePermission("ot.discharge", "hospital")
  async convert(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({
      caseId: idSchema, reason: z.string().min(1).max(500), destination: z.string().min(1).max(120).optional(),
    }), body);
    try { return await convertToAdmission(this.db, actor, { encounterId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/absconded")
  @RequirePermission("ot.discharge", "hospital")
  async absconded(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({ caseId: idSchema }), body);
    try { return await markAbsconded(this.db, actor, { encounterId, ...input }); } catch (e) { toHttp(e); }
  }

  // ── the bill: a different permission, a different desk (DD14's third separation) ──

  @Get(":encounterId/bill-preview")
  @RequirePermission("ot.bill.compose", "hospital")
  async preview(@Param("encounterId") encounterId: string): Promise<unknown> {
    try { return await composeDischargeBill(this.db, encounterId); } catch (e) { toHttp(e); }
  }

  @Post(":encounterId/bill")
  @RequirePermission("ot.bill.compose", "hospital")
  async bill(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({
      // M9 — the full tender list; `cashTenderPaise` stays as the shorthand it always was.
      tenders: z.array(z.object({
        mode: z.enum(["cash", "upi", "card"]),
        amountPaise: z.number().int().positive(),
        refText: z.string().max(120).optional(),
      })).optional(),
      cashTenderPaise: z.number().int().min(0).optional(), note: z.string().max(500).optional(),
      // M8 — a DELIBERATE second bill on this encounter (a return to theatre, N13).
      additionalBill: z.boolean().optional(),
    }), body);
    try { return await settleDischargeBill(this.db, actor, { encounterId, ...input }); } catch (e) { toHttp(e); }
  }

  @Get("unbilled")
  @RequirePermission("ot.bill.compose", "hospital")
  async unbilled(@Query("day") day: string): Promise<unknown> {
    parsed(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), day);
    try { return await unbilledDaycare(this.db, day); } catch (e) { toHttp(e); }
  }
}
