import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { openBillDecisions, resolveBillDecision } from "./money";
import { parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T7 / DD12b — **THE COUNTER'S QUEUE.**
 *
 * Four facts can diverge from what was billed, and each is money somebody has to decide about. The
 * queue exists so that the decision is taken by the counter, deliberately, rather than absorbed —
 * and it is SHORT on purpose. A5's mutant raises a decision on every acquisition, and what that
 * costs is not noise: *"the counter's queue is the whole worklist and stops being read."*
 *
 * `radiology.bill_decisions.manage` is held by `billing_manager` and `radiology_receptionist`, and
 * by neither radiologist nor radiographer. The person who performed the scan does not decide
 * whether the patient pays for it.
 */
const resolveBody = z.object({ resolution: z.string().min(1).max(400) });

@Controller("radiology/bill-decisions")
export class RadiologyBillDecisionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Everything unresolved, oldest first — the table's own `imaging_bill_decisions_open_idx`. */
  @Get()
  @RequirePermission("radiology.bill_decisions.manage", "hospital")
  async open(): Promise<unknown> {
    try {
      return { decisions: await openBillDecisions(this.db) };
    } catch (e) { toHttp(e); }
  }

  @Post(":billDecisionId/resolve")
  @RequirePermission("radiology.bill_decisions.manage", "hospital")
  async resolve(
    @CurrentActor() actor: Actor,
    @Param("billDecisionId") billDecisionId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(resolveBody, body);
    try {
      return await withTx(this.db, (tx) => resolveBillDecision(tx, actor, {
        billDecisionId, resolution: input.resolution,
      }));
    } catch (e) { toHttp(e); }
  }
}
