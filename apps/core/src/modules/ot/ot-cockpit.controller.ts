import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CONFIG } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import {
  BACKFILL_PHASES, backfillCase, completeChecklist, markClosure, markIncision, recordDeathOnTable,
  recordDoseLog, recordProcedureConverted, returnTheatreToService, signIn, signOut, timeOut,
  toHolding, verifyHolding,
  wheelOut,
} from "./cockpit";
import { countsFor, recordCount } from "./counts";
import { deployImplant, explantImplant, implantsFor } from "./implants";
import { createSpecimen, dispatchSpecimen, specimensFor } from "./specimens";
import { idSchema, parsed, toHttp } from "./ot-definitions.controller";
import type { AppConfig } from "../../kernel/config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T8 — part 3: the cockpit.
 *
 * ═══ NOT ONE ROUTE ACCEPTS A TIMESTAMP, AND THAT IS A15's MECHANICAL HALF ═══
 *
 * `wheel_in`, `induction`, `incision`, `closure` and `wheel_out` appear in NO body schema below.
 * They are set by the transitions in `cockpit.ts` from the server's clock, and `0035`'s trigger
 * refuses a rewrite whatever reaches the column. The only route that takes clinical times at all is
 * the BACKFILL, which is the one place paper is allowed to re-enter — and it flags every phase it
 * writes (DD8).
 */
const participants = z.array(idSchema).min(1).max(20);

const checklistBody = z.object({
  phase: z.enum(["signin", "timeout", "signout"]),
  items: z.unknown(),
  participants,
  halt: z.object({ reason: z.string().min(1).max(500) }).optional(),
});
const countBody = z.object({
  round: z.enum(["initial", "closing", "final"]),
  itemType: z.string().min(1).max(64),
  expected: z.number().int().min(0),
  counted: z.number().int().min(0),
  scrubBy: idSchema,
  circulatingBy: idSchema,
  version: z.number().int().positive().optional(),
});
const implantBody = z.object({
  itemId: idSchema, serviceCode: z.string().min(1).max(64), qtyBase: z.number().int().positive(),
  source: z.enum(["consignment", "patient_supplied"]).optional(),
  batchId: idSchema.optional(), lotId: idSchema.optional(), storeResourceId: idSchema.optional(),
  serial: z.string().min(1).max(64).optional(), stickerRef: z.string().min(1).max(64).optional(),
  verifiedBy: idSchema.optional(),
});
const specimenBody = z.object({
  site: z.string().min(1).max(120), container: z.string().min(1).max(64),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const backfillBody = z.object({
  reason: z.string().min(1).max(500),
  phases: z.array(z.object({
    phase: z.enum(BACKFILL_PHASES),
    occurredAt: z.string().min(1),
  })).min(1).max(BACKFILL_PHASES.length), // derived, so it cannot go stale when a phase is added or dropped
});

@Controller("ot/cockpit")
export class OtCockpitController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Get(":caseId/counts")
  @RequirePermission("ot.cases.read", "hospital")
  async counts(@Param("caseId") caseId: string): Promise<unknown> {
    try { return await countsFor(this.db, caseId); } catch (e) { toHttp(e); }
  }

  @Get(":caseId/implants")
  @RequirePermission("ot.cases.read", "hospital")
  async implants(@Param("caseId") caseId: string): Promise<unknown> {
    try { return await implantsFor(this.db, caseId); } catch (e) { toHttp(e); }
  }

  @Get(":caseId/specimens")
  @RequirePermission("ot.cases.read", "hospital")
  async specimens(@Param("caseId") caseId: string): Promise<unknown> {
    try { return await specimensFor(this.db, caseId); } catch (e) { toHttp(e); }
  }

  /** A1/A2 — the wristband scan. A mismatch is a 200 with `ok: false` and a near-miss row, NOT a
   *  4xx: the screen has to render the reason beside the two names, and an exception would lose it. */
  @Post(":caseId/verify-holding")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async verify(
    @CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(z.object({ qrPayload: z.string().min(1).max(500) }), body);
    try { return await verifyHolding(this.db, this.cfg, actor, caseId, input.qrPayload); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/to-holding")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async holding(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await toHolding(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/sign-in")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async signIn(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await signIn(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/checklist")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async checklist(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(checklistBody, body);
    try { return await completeChecklist(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/time-out")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async timeOut(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await timeOut(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/incision")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async incision(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await markIncision(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/closure")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async closure(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await markClosure(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/counts")
  @RequirePermission("ot.counts.record", "hospital")
  async count(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(countBody, body);
    try { return await recordCount(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/sign-out")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async signOut(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await signOut(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/wheel-out")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async wheelOut(@CurrentActor() actor: Actor, @Param("caseId") caseId: string): Promise<unknown> {
    try { return await wheelOut(this.db, actor, caseId); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/implants")
  @RequirePermission("ot.implants.scan", "hospital")
  async deploy(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(implantBody, body);
    try { return await withTx(this.db, (tx) => deployImplant(tx, actor, { caseId, ...input })); } catch (e) { toHttp(e); }
  }

  @Post("implants/:implantId/explant")
  @RequirePermission("ot.implants.scan", "hospital")
  async explant(@CurrentActor() actor: Actor, @Param("implantId") implantId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({ reason: z.string().min(1).max(500) }), body);
    try { return await withTx(this.db, (tx) => explantImplant(tx, actor, { implantId, ...input })); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/specimens")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async specimen(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(specimenBody, body);
    try { return await withTx(this.db, (tx) => createSpecimen(tx, actor, { caseId, ...input })); } catch (e) { toHttp(e); }
  }

  @Post("specimens/:specimenId/dispatch")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async dispatch(@CurrentActor() actor: Actor, @Param("specimenId") specimenId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({ destination: z.string().min(1).max(200) }), body);
    try { return await withTx(this.db, (tx) => dispatchSpecimen(tx, actor, { specimenId, ...input })); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/dose-log")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async doseLog(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({
      dapCgyCm2: z.number().min(0), fluoroSeconds: z.number().min(0), operatorUserId: idSchema,
    }), body);
    try { return await recordDoseLog(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/procedure-converted")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async converted(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({
      toProcedureCode: z.string().min(1).max(64), reason: z.string().min(1).max(500),
    }), body);
    try { return await recordProcedureConverted(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  @Post(":caseId/death-on-table")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async death(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(z.object({
      mlcApplicable: z.boolean(), note: z.string().min(1).max(2000),
    }), body);
    try { return await recordDeathOnTable(this.db, actor, { caseId, ...input }); } catch (e) { toHttp(e); }
  }

  /** C1/DD8 — the ONE route that takes clinical times, and every phase it writes is flagged. */
  @Post(":caseId/backfill")
  @RequirePermission("ot.cockpit.operate", "hospital")
  async backfill(@CurrentActor() actor: Actor, @Param("caseId") caseId: string, @Body() body: unknown): Promise<unknown> {
    const input = parsed(backfillBody, body);
    try {
      return await backfillCase(this.db, actor, {
        caseId, reason: input.reason,
        phases: input.phases.map((p) => ({ phase: p.phase, occurredAt: new Date(p.occurredAt) })),
      });
    } catch (e) { toHttp(e); }
  }

  /**
   * PASS-2 MAJOR-6 — the way back from a blocked theatre. Gated on `ot.list.manage` at the route
   * and narrowed to the IN-CHARGE inside `returnTheatreToService`, because that permission is also
   * held by the day-care coordinator and this is not their call.
   */
  @Post("theatre/:theatreResourceId/return-to-service")
  @RequirePermission("ot.list.manage", "hospital")
  async returnTheatre(
    @CurrentActor() actor: Actor,
    @Param("theatreResourceId") theatreResourceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(z.object({ reason: z.string().min(1).max(500) }), body);
    try { return await returnTheatreToService(this.db, actor, { theatreResourceId, ...input }); }
    catch (e) { toHttp(e); }
  }
}
