import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { otCaseGates } from "../../kernel/db/schema";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { CANCELLATION_ATTRIBUTION_VALUES, PAYER_CLASS_VALUES, ANAESTHESIA_TYPE_VALUES } from "../../kernel/db/schema/ot";
import { bookCase, cancelCase, changePayerClass, postponeCase } from "./booking";
import { holdDeposit, releaseHolds, requestDepositException } from "./deposit";
import { caseGates, evaluateReadiness, overrideGate, satisfyGate, waiveGate } from "./gates";
import { listForDay, printPack, publishList, resequence } from "./lists";
import { idSchema, parsed, toHttp } from "./ot-definitions.controller";
import type { PayerClass } from "./deposit";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T8 — part 2: booking, the gates and the list.
 *
 * Every route carries `@RequirePermission` and none carries a check of its own: AuthGuard and
 * PermissionGuard are global APP_GUARDs from AuthModule (Plan 13 T5's recorded rule), so mounting
 * this controller mounts its checks with it.
 *
 * **`ot.gates.override` is a SEPARATE permission from `ot.gates.satisfy`, and the route split is
 * the visible half of DD14's first separation**: the coordinator who chases gates all morning
 * cannot reach the override lane, whatever the two-actor check would have said.
 */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const bookBody = z.object({
  patientId: idSchema,
  opdEncounterId: idSchema.optional(),
  procedureCode: z.string().min(1).max(64),
  procedureClass: z.string().min(1).max(64),
  laterality: z.enum(["left", "right", "bilateral"]).optional(),
  surgeonId: idSchema,
  anaesthetistId: idSchema.optional(),
  anaesthesiaType: z.enum(ANAESTHESIA_TYPE_VALUES).optional(),
  asaGrade: z.number().int().min(1).max(5).optional(),
  listDate: dateStr,
  payerClass: z.enum(PAYER_CLASS_VALUES),
  schemeRef: z.string().min(1).max(64).optional(),
  implantEstimatePaise: z.number().int().min(0).optional(),
  sanctionedPaise: z.number().int().min(0).optional(),
  creditAvailablePaise: z.number().int().min(0).optional(),
  entitlementPaise: z.number().int().min(0).optional(),
  encounterId: idSchema.optional(),
  returnOfCaseId: idSchema.optional(),
  force: z.boolean().optional(),
});

const cancelBody = z.object({
  reason: z.string().min(1).max(500),
  attribution: z.enum(CANCELLATION_ATTRIBUTION_VALUES),
});
const postponeBody = z.object({
  reason: z.enum(["no_sterile_set", "surgeon_no_show", "payer_denied", "patient_unfit", "equipment_unavailable"]),
  newListDate: dateStr,
});
const payerBody = z.object({
  to: z.enum(PAYER_CLASS_VALUES), reason: z.string().min(1).max(500),
  sanctionedPaise: z.number().int().min(0).optional(),
  creditAvailablePaise: z.number().int().min(0).optional(),
  entitlementPaise: z.number().int().min(0).optional(),
});
const holdBody = z.object({
  receiptId: idSchema, amountPaise: z.number().int().positive(),
  paidBy: z.object({ name: z.string().min(1), relation: z.string().min(1), phone: z.string().min(1) }).optional(),
});
const exceptionBody = z.object({
  patientId: idSchema, allowedShortfallPaise: z.number().int().positive(), reason: z.string().min(1).max(500),
});
const overrideBody = z.object({
  surgeonId: idSchema, anaesthetistId: idSchema, reason: z.string().min(1).max(500),
});
const waiveBody = z.object({ reason: z.string().min(1).max(500) });
const publishBody = z.object({ listDate: dateStr, theatreResourceId: idSchema });
/**
 * ═══ A SEAM DRAWN FROM BOTH ENDS ═══
 *
 * The cockpit posted `{ listDate, theatreResourceId, order, reason }` and this schema read
 * `caseIdsInOrder` and declared no `reason`. **Neither end was wrong about what it meant and they
 * could not talk**: `order` failed validation outright, and `reason` — which zod strips rather than
 * refuses — vanished silently even once the array was named correctly.
 *
 * The SERVER's name wins for the array, because `resequence` validates against it (every case named,
 * no duplicates, the whole list) and the audit story is built on it. The CLIENT wins on `reason`
 * existing at all: it had always sent one, and `list.resequenced` is the thing that needed somewhere
 * to put it. Optional, because the route has been callable without one since Plan 15.
 */
const resequenceBody = publishBody.extend({
  caseIdsInOrder: z.array(idSchema).min(1).max(50),
  reason: z.string().min(1).max(500).optional(),
});

@Controller("ot")
export class OtCasesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("list")
  @RequirePermission("ot.cases.read", "hospital")
  async list(
    @CurrentActor() actor: Actor,
    @Query("listDate") listDate: string,
    @Query("theatreResourceId") theatreResourceId: string,
  ): Promise<unknown> {
    parsed(dateStr, listDate);
    // The ACTOR is passed because the list's patient names depend on who is asking (F20).
    try { return await listForDay(this.db, actor, listDate, theatreResourceId); } catch (e) { toHttp(e); }
  }

  @Get("cases/:caseId/pack")
  @RequirePermission("ot.cases.read", "hospital")
  async pack(@Param("caseId") caseId: string): Promise<unknown> {
    try { return await printPack(this.db, caseId); } catch (e) { toHttp(e); }
  }

  @Get("cases/:caseId/gates")
  @RequirePermission("ot.cases.read", "hospital")
  async gates(@Param("caseId") caseId: string): Promise<unknown> {
    try { return await caseGates(this.db, caseId); } catch (e) { toHttp(e); }
  }

  @Post("cases")
  @RequirePermission("ot.cases.book", "hospital")
  async book(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(bookBody, body);
    try { return await bookCase(this.db, actor, { ...input, payerClass: input.payerClass as PayerClass }); }
    catch (e) { toHttp(e); }
  }

  @Post("cases/:caseId/cancel")
  @RequirePermission("ot.cases.cancel", "hospital")
  async cancel(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(cancelBody, body);
    try { return await cancelCase(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post("cases/:caseId/postpone")
  @RequirePermission("ot.cases.cancel", "hospital")
  async postpone(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(postponeBody, body);
    try { return await postponeCase(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post("encounters/:encounterId/payer-class")
  @RequirePermission("ot.cases.book", "hospital")
  async payerClass(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(payerBody, body);
    try { return await changePayerClass(this.db, actor, { encounterId, ...input, to: input.to as PayerClass }); }
    catch (e) { toHttp(e); }
  }

  @Post("encounters/:encounterId/deposit-hold")
  @RequirePermission("ot.cases.book", "hospital")
  async hold(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(holdBody, body);
    try { return await withTx(this.db, (tx) => holdDeposit(tx, actor, { encounterId, ...input })); }
    catch (e) { toHttp(e); }
  }

  @Post("encounters/:encounterId/deposit-exception")
  @RequirePermission("ot.cases.book", "hospital")
  async depositException(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(exceptionBody, body);
    try { return await withTx(this.db, (tx) => requestDepositException(tx, actor, { encounterId, ...input })); }
    catch (e) { toHttp(e); }
  }

  @Post("encounters/:encounterId/release-holds")
  @RequirePermission("ot.cases.cancel", "hospital")
  async release(@Param("encounterId") encounterId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(waiveBody, body);
    try { return await withTx(this.db, (tx) => releaseHolds(tx, encounterId, input.reason)); }
    catch (e) { toHttp(e); }
  }

  // ── the gates ──

  @Post("gates/:gateId/satisfy")
  @RequirePermission("ot.gates.satisfy", "hospital")
  async satisfy(@CurrentActor() actor: Actor, @Param("gateId") gateId: string, @Body() body: unknown): Promise<unknown> {
    /**
     * Readiness is evaluated in the SAME transaction as the satisfy. The caller is a screen that
     * does not know which gate was the last one, and a case left `listed` because nobody asked is a
     * theatre slot that goes unused — but more sharply, two screens satisfying the last two gates
     * at once must not both find one gate open and neither flip the case.
     */
    try {
      return await withTx(this.db, async (tx) => {
        const result = await satisfyGate(tx, actor, gateId, body);
        const gate = (await tx.select().from(otCaseGates).where(eq(otCaseGates.id, gateId)))[0]!;
        const readiness = await evaluateReadiness(tx, gate.caseId);
        return { ...result, readiness };
      });
    } catch (e) { toHttp(e); }
  }

  @Post("cases/:caseId/evaluate-readiness")
  @RequirePermission("ot.gates.satisfy", "hospital")
  async readiness(@Param("caseId") caseId: string): Promise<unknown> {
    try { return await withTx(this.db, (tx) => evaluateReadiness(tx, caseId)); } catch (e) { toHttp(e); }
  }

  @Post("gates/:gateId/waive")
  @RequirePermission("ot.gates.satisfy", "hospital")
  async waive(@CurrentActor() actor: Actor, @Param("gateId") gateId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(waiveBody, body);
    try { return await withTx(this.db, (tx) => waiveGate(tx, actor, gateId, input.reason)); } catch (e) { toHttp(e); }
  }

  /** DD14's first separation, as a route: `ot.gates.override`, never `ot.gates.satisfy`. */
  @Post("gates/:gateId/override")
  @RequirePermission("ot.gates.override", "hospital")
  async override(@CurrentActor() actor: Actor, @Param("gateId") gateId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(overrideBody, body);
    try { return await withTx(this.db, (tx) => overrideGate(tx, actor, gateId, input)); } catch (e) { toHttp(e); }
  }

  // ── the list ──

  @Post("lists/publish")
  @RequirePermission("ot.list.manage", "hospital")
  async publish(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(publishBody, body);
    try { return await publishList(this.db, actor, input); } catch (e) { toHttp(e); }
  }

  @Post("lists/resequence")
  @RequirePermission("ot.list.manage", "hospital")
  async resequence(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(resequenceBody, body);
    try { return await resequence(this.db, actor, input); } catch (e) { toHttp(e); }
  }
}
