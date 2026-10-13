import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { IPD_BEDS_CLEAN, IPD_BEDS_VIEW, IpdRefusal, ipdRefusalStatus } from "../ipd";
import { TaskError, taskHttpStatus } from "../tasks";
import { MaintenanceRefusal, maintenanceHttpStatus } from "./errors";
import { MAINTENANCE_CONFIRM, MAINTENANCE_MANAGE, MAINTENANCE_RAISE, MAINTENANCE_VIEW, MAINTENANCE_WORK } from "./names";
import { bedTickets, maintenanceBoard, placesForRaise } from "./reads";
import { cancelTicket, confirmTicket, dispatchTicket, raiseTicket } from "./tickets";
import type { Actor, BedTicketsView, MaintenanceBoardView, MaintenancePlace, RaiseTicketResult } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TicketRow } from "./store";

/**
 * THE MAINTENANCE DOORS. Every refusal answers `{ code, message, fix }` — maintenance's own, the task engine's, or
 * the beds module's (its rule and fix). The technicians' own acts (accept, start, done) are the task engine's doors
 * on "My tasks"; the nurse's confirmation is here and also on the task engine's verify door.
 */
type Ack = { id: string; number: number; state: string; version: number };
const ack = (r: TicketRow): Ack => ({ id: r.id, number: r.number, state: r.state, version: r.version });
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MaintenanceRefusal) {
      const status = maintenanceHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    if (e instanceof TaskError) {
      const status = taskHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    if (e instanceof IpdRefusal) {
      const status = ipdRefusalStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    throw e;
  }
}

@Controller("maintenance")
export class MaintenanceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("board")
  @RequirePermission(MAINTENANCE_VIEW, "hospital", { alsoAdmits: [MAINTENANCE_WORK, MAINTENANCE_MANAGE] })
  async board(): Promise<MaintenanceBoardView> {
    return maintenanceBoard(this.db);
  }

  /** The Beds board's repair line: whoever reads the Beds board reads it. */
  @Get("bed-tickets")
  @RequirePermission(IPD_BEDS_VIEW, "hospital", { alsoAdmits: [MAINTENANCE_VIEW] })
  async bedTickets(): Promise<BedTicketsView> {
    return bedTickets(this.db);
  }

  @Get("places")
  @RequirePermission(MAINTENANCE_RAISE, "hospital")
  async places(@Query("q") q?: string): Promise<MaintenancePlace[]> {
    return placesForRaise(this.db, typeof q === "string" ? q.slice(0, 64) : "");
  }

  @Post("tickets")
  @RequirePermission(MAINTENANCE_RAISE, "hospital")
  async raise(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<RaiseTicketResult> {
    return refusing(() => raiseTicket(this.db, actor, body(b)));
  }

  /** The nurse's confirmation: `ipd.beds.clean` or `maintenance.confirm` (the kind's verifier list re-checks). */
  @Post("tickets/:id/confirm")
  @RequirePermission(MAINTENANCE_CONFIRM, "hospital", { alsoAdmits: [IPD_BEDS_CLEAN] })
  async confirm(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<Ack> {
    return refusing(async () => ack(await confirmTicket(this.db, actor, { ticketId: id })));
  }

  @Post("tickets/:id/cancel")
  @RequirePermission(MAINTENANCE_MANAGE, "hospital")
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await cancelTicket(this.db, actor, { ...body(b), ticketId: id })));
  }

  @Post("tickets/:id/dispatch")
  @RequirePermission(MAINTENANCE_MANAGE, "hospital")
  async dispatch(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<Ack> {
    return refusing(async () => ack(await dispatchTicket(this.db, actor, { ticketId: id })));
  }
}
