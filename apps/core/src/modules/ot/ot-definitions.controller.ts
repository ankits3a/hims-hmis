import { BadRequestException, Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { ApprovalError } from "../../kernel/approvals/types";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { WorkflowError } from "../../kernel/workflow/instances";
import { SodViolationError } from "../../kernel/auth/sod";
import { OtError, otHttpStatus } from "./errors";
import { BillingError, billingHttpStatus } from "../billing";
import { TariffError, tariffHttpStatus } from "../tariff";
import { OT_DEFINITION_KIND_VALUES } from "../../kernel/db/schema/ot";
import {
  activeDefinitionRow, draftDefinition, publishDefinition, requestDefinitionPublish,
} from "./definitions";
import type { OtDefinitionKind } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T8 — the OT module's HTTP surface, part 1: governed definition data.
 *
 * ═══ `toHttp` GOES THROUGH THE SHARED MAPPER, AND THIS MODULE CAN RAISE FIVE CLASSES ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped billing's `toHttp` and reached a busy counter as
 * a 500; **Plan 13 shipped the same defect a second time, introduced by the FIX for the first**;
 * Plan 14 shipped it a third time and its own e2e caught an unmapped `ApprovalError`. This module
 * calls FIVE error-raising layers, so all five are mapped here and `ot.e2e.test.ts` drives a real
 * refusal from each family to a 4xx:
 *
 *   · `OtError`            — this module's own, through the exported `otHttpStatus` table.
 *   · `ApprovalError`      — `publishDefinition` and the deposit exception both file approvals.
 *   · `ResourceError`      — `signIn` and `admitToBay` reach the registry; `already_occupied` is a
 *                            409 and NOT a 500, which is the whole of Plan 13's own specimen.
 *   · `WorkflowError`      — every transition. `unknown_transition` and `role_denied` are refusals a
 *                            nurse must see as a rule, not as a crash.
 *   · `SodViolationError`  — `recordCount` blocks one nurse being both scrub and circulating.
 *
 * An error this mapper does not recognise RETHROWS: a 500 is a genuine bug and should be loud.
 */
export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof OtError) throw httpError(otHttpStatus(e.code), e.message, e.code, e.detail);
  /**
   * ═══ BILLING AND TARIFF, BECAUSE T7 GAVE THIS MODULE A ROUTE THAT ISSUES AN INVOICE ═══
   *
   * T8's Files list named `OtError`, `ResourceError` and `WorkflowError`; it was written before T7
   * discovered that the discharge bill has to call `issueInvoice` itself. The e2e caught the gap the
   * only way it could be caught — by walking a real case whose bill exceeded its deposit and getting
   * **500 `BillingError: 4200000p would be left unsettled`** back. A cashier reading that has no idea
   * they need to take the balance; a 409 with `code: "unsettled_issue_refused"` says exactly that.
   *
   * Both status functions are IMPORTED from the owning module (§2.54, and Plan 09's
   * `membershipHttpStatus` precedent): a copied table drifts the moment billing adds a code.
   */
  if (e instanceof BillingError) throw httpError(billingHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof TariffError) throw httpError(tariffHttpStatus(e.code), e.message, e.code);
  if (e instanceof ApprovalError) throw httpError(409, e.message, e.code);
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code);
  /**
   * A workflow refusal is a 409: the request was well-formed and the case is in the wrong state or
   * the actor holds the wrong role. `role_denied` is a 403 within that — "you may not" rather than
   * "not now" — and a screen that cannot tell them apart shows a nurse the wrong modal.
   */
  if (e instanceof WorkflowError) {
    throw httpError(e.code === "role_denied" ? 403 : 409, e.message, e.code);
  }
  if (e instanceof SodViolationError) {
    throw httpError(403, e.message, "sod_violation", { pairKey: e.pairKey });
  }
  throw e;
}

export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

export const idSchema = z.string().min(1).max(64);

const draftBody = z.object({
  kind: z.enum(OT_DEFINITION_KIND_VALUES),
  body: z.unknown(),
});
const publishBody = z.object({ approvalId: idSchema });

@Controller("ot/definitions")
export class OtDefinitionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The ACTIVE definition of a kind — what the unit is currently allowed to do. */
  @Get(":kind")
  @RequirePermission("ot.definitions.read", "hospital")
  async active(@Param("kind") kind: string): Promise<unknown> {
    if (!(OT_DEFINITION_KIND_VALUES as readonly string[]).includes(kind)) {
      throw new BadRequestException(`unknown definition kind "${kind}"`);
    }
    const row = await activeDefinitionRow(this.db, kind as OtDefinitionKind);
    // `null` rather than a 404: "nothing is published yet" is a state the screen renders, not an
    // error — it is the unit's state at go-live and the runbook's first step.
    return row ?? null;
  }

  @Post("draft")
  @RequirePermission("ot.definitions.manage", "hospital")
  async draft(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ definitionId: string; version: number }> {
    const input = parsed(draftBody, body);
    try {
      return await withTx(this.db, (tx) => draftDefinition(tx, actor, { kind: input.kind, body: input.body }));
    } catch (e) { toHttp(e); }
  }

  /** Files the `ot_definition_publish` approval. The engine's SoD forces the second human. */
  @Post(":definitionId/request-publish")
  @RequirePermission("ot.definitions.manage", "hospital")
  async requestPublish(
    @CurrentActor() actor: Actor, @Param("definitionId") definitionId: string,
  ): Promise<{ approvalId: string }> {
    try {
      return await withTx(this.db, (tx) => requestDefinitionPublish(tx, actor, definitionId));
    } catch (e) { toHttp(e); }
  }

  @Post(":definitionId/publish")
  @RequirePermission("ot.definitions.manage", "hospital")
  async publish(
    @CurrentActor() actor: Actor, @Param("definitionId") definitionId: string, @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(publishBody, body);
    try {
      return await publishDefinition(this.db, actor, { definitionId, approvalId: input.approvalId });
    } catch (e) { toHttp(e); }
  }
}
