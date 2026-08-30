import { Body, Controller, Get, Headers, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB, MODULE_REGISTRY } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { withIdempotency } from "../billing";
import { receive, reject } from "./accession";
import { acknowledgeCritical, openCriticalCalls } from "./criticals";
import { enterResult } from "./results";
import { benchWorklist } from "./worklist";
import { idSchema, LAB_IDEMPOTENT_ROUTES, parsed, toHttp } from "./lab-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ModuleRegistry } from "../../kernel/modules/loader";

/**
 * PLAN 17b T8 — **THE BENCH OVER HTTP**: accession, the number, and the call ladder.
 *
 * ═══ `absurdOverride` CROSSES THE WIRE AS A NAMED SECOND PERSON, NEVER AS A BOOLEAN ═══
 *
 * 02 H1's control is *a second holder of `lab.results.enter` put their name on it*. A wire schema
 * carrying `{ force: true }` would make the override a checkbox the same technologist ticks, which
 * is the dialog people learn to click. The field is a `users.id`, the service refuses it when it
 * equals the enterer, and it is STORED — so "who let a glucose of 1600 through" is answerable.
 */
const receiveBody = z.object({
  specimenNo: z.string().min(1).max(32),
  containerSeen: z.string().max(48).optional(),
  identityRecheckBy: z.string().max(120).optional(),
  downtimeKitSerial: z.string().max(64).optional(),
});
const rejectBody = z.object({
  specimenNo: z.string().min(1).max(32),
  reason: z.enum([
    "haemolysed", "clotted", "insufficient", "wrong_container", "unlabelled", "mislabelled",
    "leaked", "contaminated", "delayed_transport", "temperature_excursion",
  ]),
  attributableTo: z.enum(["collection", "transport", "lab", "patient"]),
});
const resultBody = z.object({
  orderItemId: idSchema,
  analyteId: idSchema,
  value: z.string().min(1).max(500),
  unit: z.string().max(32).nullish(),
  entryMode: z.enum(["manual", "manual_from_printout"]),
  remarks: z.string().max(500).nullish(),
  absurdOverride: z.object({ by: idSchema }).optional(),
});
const ackBody = z.object({
  attempt: z.object({
    contact: z.string().min(1).max(160),
    outcome: z.enum(["no_answer", "engaged", "message_left", "spoke"]),
  }).optional(),
  readback: z.string().max(500).optional(),
});

@Controller("lab/bench")
export class LabBenchController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  /** As `lab-desk.controller.ts`: the INSTALLED registry, never the full manifest catalogue. */
  private decls() { return collectOrderKinds(this.registry); }

  @Post("receive")
  @RequirePermission("lab.accession.operate", "hospital")
  async accession(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(receiveBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.receive, key },
        input,
        () => withTx(this.db, (tx) => receive(tx, actor, this.decls(), input)),
      );
    } catch (e) { toHttp(e); }
  }

  /** A rejected tube costs the patient NOTHING: a replacement is opened and no invoice is issued. */
  @Post("reject")
  @RequirePermission("lab.accession.operate", "hospital")
  async refuse(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(rejectBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.reject, key },
        input,
        () => withTx(this.db, (tx) => reject(tx, actor, input)),
      );
    } catch (e) { toHttp(e); }
  }

  @Post("results")
  @RequirePermission("lab.results.enter", "hospital")
  async result(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Headers("idempotency-key") key?: string,
  ): Promise<unknown> {
    const input = parsed(resultBody, body);
    try {
      return await withIdempotency(
        this.db,
        { actorId: actor.id, route: LAB_IDEMPOTENT_ROUTES.enterResult, key },
        input,
        () => withTx(this.db, (tx) => enterResult(tx, actor, input)),
      );
    } catch (e) { toHttp(e); }
  }

  /** DD12 — the open ladder. What a shift handover reads at 07:00, and what nobody may close blind. */
  @Get("criticals")
  @RequirePermission("lab.criticals.close", "hospital")
  async criticals(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await openCriticalCalls(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("criticals/:callId/ack")
  @RequirePermission("lab.criticals.close", "hospital")
  async ack(
    @CurrentActor() actor: Actor,
    @Param("callId") callId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(ackBody, body);
    try {
      return await withTx(this.db, (tx) => acknowledgeCritical(tx, actor, { callId, ...input }));
    } catch (e) { toHttp(e); }
  }

  /** The bench worklist: items the department has started and not yet resulted, oldest first. */
  @Get("worklist")
  @RequirePermission("lab.worklist.read", "hospital")
  async worklist(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await benchWorklist(this.db, actor); } catch (e) { toHttp(e); }
  }
}
