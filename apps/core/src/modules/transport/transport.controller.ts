import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { TaskError, TaskKindRefusal, taskHttpStatus } from "../tasks";
import { TRANSPORT_MANAGE, TRANSPORT_REQUEST, TRANSPORT_WORK } from "./names";
import { patientOptions, placeOptions, transportBoard, transportDetails } from "./reads";
import { addEscort, escortCandidates, recordOxygenCheck, requestTransport } from "./requests";
import type {
  Actor, TransportBoardView, TransportDetailsView, TransportEscortOption, TransportPatientOption, TransportPlaceOption,
  TransportRequestAck,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE TRANSPORT DOORS. Every refusal answers `{ code, message, fix }` — transport's own or the engine's.
 * The porter's own acts (accept, start, done with the wristband scan) are the task engine's doors (`/tasks/:id/...`),
 * on "My tasks"; the start and done rules run inside them (the kind hooks).
 */
type Ack = { taskId: string };
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TaskKindRefusal) {
      throw new HttpException({ statusCode: e.httpStatus, code: e.code, message: e.message, fix: e.fix }, e.httpStatus);
    }
    if (e instanceof TaskError) {
      const status = taskHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    throw e;
  }
}

@Controller("transport")
export class TransportController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post("requests")
  @RequirePermission(TRANSPORT_REQUEST, "hospital", { alsoAdmits: [TRANSPORT_MANAGE] })
  async request(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<TransportRequestAck> {
    return refusing(async () => {
      const r = await requestTransport(this.db, actor, body(b));
      return { taskId: r.task.id, state: r.task.state, version: r.task.version, merged: r.merged, escortRequired: r.request.escortRequired };
    });
  }

  /** The porter's cards: `?ids=a,b,c` (at most 100). */
  @Get("details")
  @RequirePermission(TRANSPORT_WORK, "hospital", { alsoAdmits: [TRANSPORT_REQUEST, TRANSPORT_MANAGE] })
  async details(@CurrentActor() actor: Actor, @Query("ids") ids?: string): Promise<TransportDetailsView> {
    return transportDetails(this.db, actor, (ids ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""));
  }

  @Get("board")
  @RequirePermission(TRANSPORT_MANAGE, "hospital")
  async board(): Promise<TransportBoardView> {
    return transportBoard(this.db);
  }

  @Get("patients")
  @RequirePermission(TRANSPORT_REQUEST, "hospital", { alsoAdmits: [TRANSPORT_MANAGE] })
  async patients(@CurrentActor() actor: Actor, @Query("q") q?: string): Promise<TransportPatientOption[]> {
    return patientOptions(this.db, actor, q ?? "");
  }

  @Get("places")
  @RequirePermission(TRANSPORT_REQUEST, "hospital", { alsoAdmits: [TRANSPORT_MANAGE] })
  async places(): Promise<TransportPlaceOption[]> {
    return placeOptions(this.db);
  }

  @Get("escorts")
  @RequirePermission(TRANSPORT_WORK, "hospital", { alsoAdmits: [TRANSPORT_REQUEST, TRANSPORT_MANAGE] })
  async escorts(): Promise<TransportEscortOption[]> {
    return escortCandidates(this.db);
  }

  @Post("tasks/:id/escort")
  @RequirePermission(TRANSPORT_WORK, "hospital", { alsoAdmits: [TRANSPORT_REQUEST, TRANSPORT_MANAGE] })
  async escort(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => {
      await addEscort(this.db, actor, { ...body(b), taskId: id });
      return { taskId: id };
    });
  }

  @Post("tasks/:id/oxygen-check")
  @RequirePermission(TRANSPORT_WORK, "hospital", { alsoAdmits: [TRANSPORT_REQUEST, TRANSPORT_MANAGE] })
  async oxygen(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => {
      await recordOxygenCheck(this.db, actor, { ...body(b), taskId: id });
      return { taskId: id };
    });
  }
}
