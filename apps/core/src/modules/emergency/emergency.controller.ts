import { Body, Controller, Get, HttpException, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { BillingError, billingHttpStatus } from "../billing";
import { PatientError } from "../patients";
import { cancelPreAlert, preAlert, recordBroughtDead, registerArrival, registerUnidentified } from "./arrival";
import { printErBand, reprintErBand } from "./bands";
import { listErDoctors, readErBoard, readErDesk, searchErPatients } from "./board";
import { ErError, ErRefusal, erRefusalStatus } from "./errors";
import { linkIdentity } from "./identity";
import { ER_ARRIVAL_REGISTER, ER_BOARD_VIEW, ER_IDENTITY_LINK } from "./names";
import type { Actor, ErBoard, ErDeskView, ErDoctorOption, ErPatientHit, ErRefusalBody } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ER lane 1 (#808) — the emergency routes (`ER_ROUTES`). Thin: each route is its intent function, and the function
 * re-checks the permission the guard checked (the copilot and devices reach the same functions without this controller).
 * A refusal answers its contract code with the rule, the fix and its data (`ErRefusalBody`).
 */
function toHttp(e: unknown): never {
  if (e instanceof ErRefusal) {
    const status = erRefusalStatus(e.code);
    const body: ErRefusalBody = { statusCode: status, code: e.code, message: e.message, rule: e.rule, fix: e.fix };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, status);
  }
  if (e instanceof ErError) {
    const status = e.code === "er_forbidden" ? 403 : 422;
    throw new HttpException({ statusCode: status, code: e.code, message: e.message, detail: e.detail }, status);
  }
  if (e instanceof PatientError) {
    throw new HttpException({ statusCode: 422, code: e.code, message: e.message }, 422);
  }
  if (e instanceof BillingError) {
    const status = billingHttpStatus(e.code);
    throw new HttpException({ statusCode: status, code: e.code, message: e.message }, status);
  }
  if (e instanceof z.ZodError) {
    throw new HttpException({ statusCode: 400, code: "invalid_request", message: "request body failed validation", detail: e.issues }, 400);
  }
  throw e;
}

const boardQuery = z.object({ wall: z.enum(["0", "1", "true", "false"]).optional() });
const searchQuery = z.object({ q: z.string().max(80).default("") });

@Controller("er")
export class EmergencyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission(ER_BOARD_VIEW, "hospital")
  async board(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<ErBoard> {
    try {
      const q = boardQuery.parse(query);
      return await readErBoard(this.db, actor, { wall: q.wall === "1" || q.wall === "true" });
    } catch (e) { toHttp(e); }
  }

  @Get("desk")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async desk(@CurrentActor() actor: Actor): Promise<ErDeskView> {
    try { return await readErDesk(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("patients")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async patients(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<ErPatientHit[]> {
    try { return await searchErPatients(this.db, actor, searchQuery.parse(query).q); } catch (e) { toHttp(e); }
  }

  @Get("doctors")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async doctors(@CurrentActor() actor: Actor): Promise<ErDoctorOption[]> {
    try { return await listErDoctors(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post("pre-alerts")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async preAlert(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await preAlert(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("pre-alerts/cancel")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async cancelPreAlert(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await cancelPreAlert(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("arrivals")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async arrive(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await registerArrival(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("arrivals/unidentified")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async unidentified(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await registerUnidentified(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("arrivals/brought-dead")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async broughtDead(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await recordBroughtDead(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bands/print")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async printBand(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await printErBand(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("bands/reprint")
  @RequirePermission(ER_ARRIVAL_REGISTER, "hospital")
  async reprintBand(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await reprintErBand(this.db, actor, body); } catch (e) { toHttp(e); }
  }

  @Post("identity/link")
  @RequirePermission(ER_IDENTITY_LINK, "hospital")
  async linkIdentity(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    try { return await linkIdentity(this.db, actor, body); } catch (e) { toHttp(e); }
  }
}
