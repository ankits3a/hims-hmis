import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { IPD_BEDS_CLEAN, IPD_BEDS_MANAGE, IPD_BEDS_VIEW } from "../ipd";
import { TaskError, taskHttpStatus } from "../tasks";
import { nudgeClean, verifyClean } from "./cleans";
import { HousekeepingRefusal, housekeepingHttpStatus } from "./errors";
import { HOUSEKEEPING_VERIFY_TERMINAL, HOUSEKEEPING_VIEW } from "./names";
import { bedCleans, housekeepingBoard } from "./reads";
import type { Actor, BedCleansView, HousekeepingBoardView } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * THE HOUSEKEEPING DOORS. Every refusal answers `{ code, message, fix }` — housekeeping's own or the engine's.
 * The cleaners' own acts (accept, start, done) are the task engine's doors (`/tasks/:id/...`), on "My tasks".
 */
type Ack = { id: string; state: string; version: number };
const ack = (r: TaskRow): Ack => ({ id: r.id, state: r.state, version: r.version });
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HousekeepingRefusal) {
      const status = housekeepingHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    if (e instanceof TaskError) {
      const status = taskHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    throw e;
  }
}

@Controller("housekeeping")
export class HousekeepingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The Beds board's cleaning clocks: whoever reads the board reads its clocks. */
  @Get("bed-cleans")
  @RequirePermission(IPD_BEDS_VIEW, "hospital", { alsoAdmits: [HOUSEKEEPING_VIEW] })
  async cleans(): Promise<BedCleansView> {
    return bedCleans(this.db);
  }

  @Get("board")
  @RequirePermission(HOUSEKEEPING_VIEW, "hospital")
  async board(): Promise<HousekeepingBoardView> {
    return housekeepingBoard(this.db);
  }

  /** A routine clean: `ipd.beds.clean` or the supervisor; a terminal clean: the supervisor (checked in the intent). */
  @Post("cleans/:id/verify")
  @RequirePermission(IPD_BEDS_CLEAN, "hospital", { alsoAdmits: [HOUSEKEEPING_VERIFY_TERMINAL] })
  async verify(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await verifyClean(this.db, actor, { ...body(b), taskId: id })));
  }

  /** DECIDED: the bed manager, the ward nurse side and the housekeeping supervisor may nudge. */
  @Post("cleans/:id/nudge")
  @RequirePermission(IPD_BEDS_MANAGE, "hospital", { alsoAdmits: [IPD_BEDS_CLEAN, HOUSEKEEPING_VIEW] })
  async nudge(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await nudgeClean(this.db, actor, { ...body(b), taskId: id })));
  }
}
