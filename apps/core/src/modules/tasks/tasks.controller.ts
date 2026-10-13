import { Body, Controller, Get, HttpException, Inject, Param, Post } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { hasPermission } from "../../kernel/auth/permissions";
import { TaskError, taskHttpStatus } from "./errors";
import {
  acceptTask, assignTask, cancelTask, cancelTasksForPlace, completeTask, raiseTask, returnToPool, startTask, verifyTask,
} from "./engine";
import { TASKS_SUPERVISE, TASKS_VIEW, TASKS_WORK } from "./manifest";
import { myTasks, taskBoard } from "./reads";
import type { Actor, MyTasksView, TaskBoardView } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TaskRow } from "./engine";

/**
 * THE TASK DOORS. The door checks the permission; the intent checks what a permission cannot say
 * (the task is yours, the verifier is not the doer). A refusal answers `{ code, message, fix }`.
 * Every answer is a task's id, state and version — the screens re-read their list; no money, no patient.
 */
type Ack = { id: string; state: string; version: number };
const ack = (r: TaskRow): Ack => ({ id: r.id, state: r.state, version: r.version });
const body = (b: unknown): Record<string, unknown> => (typeof b === "object" && b !== null ? b as Record<string, unknown> : {});

async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TaskError) {
      const status = taskHttpStatus(e.code);
      throw new HttpException({ statusCode: status, code: e.code, message: e.message, fix: e.fix }, status);
    }
    throw e;
  }
}

@Controller("tasks")
export class TasksController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private supervisor(actor: Actor): Promise<boolean> {
    return hasPermission(this.db, actor.id, TASKS_SUPERVISE, "hospital");
  }

  @Get("mine")
  @RequirePermission(TASKS_WORK, "hospital")
  async mine(@CurrentActor() actor: Actor): Promise<MyTasksView> {
    return myTasks(this.db, actor.id);
  }

  @Get("board")
  @RequirePermission(TASKS_VIEW, "hospital", { alsoAdmits: [TASKS_SUPERVISE] })
  async board(): Promise<TaskBoardView> {
    return taskBoard(this.db);
  }

  @Post()
  @RequirePermission(TASKS_WORK, "hospital", { alsoAdmits: [TASKS_SUPERVISE] })
  async raise(@CurrentActor() actor: Actor, @Body() b: unknown): Promise<Ack & { merged: boolean }> {
    return refusing(async () => {
      const { task, merged } = await raiseTask(this.db, actor, b);
      return { ...ack(task), merged };
    });
  }

  @Post("places/:placeId/cancel")
  @RequirePermission(TASKS_SUPERVISE, "hospital")
  async cancelPlace(@CurrentActor() actor: Actor, @Param("placeId") placeId: string, @Body() b: unknown): Promise<{ cancelled: string[] }> {
    return refusing(async () => ({ cancelled: await cancelTasksForPlace(this.db, actor, { ...body(b), placeResourceId: placeId }) }));
  }

  @Post(":id/assign")
  @RequirePermission(TASKS_SUPERVISE, "hospital")
  async assign(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await assignTask(this.db, actor, { ...body(b), taskId: id })));
  }

  @Post(":id/accept")
  @RequirePermission(TASKS_WORK, "hospital")
  async accept(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await acceptTask(this.db, actor, { ...body(b), taskId: id })));
  }

  @Post(":id/start")
  @RequirePermission(TASKS_WORK, "hospital")
  async start(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await startTask(this.db, actor, { ...body(b), taskId: id })));
  }

  @Post(":id/done")
  @RequirePermission(TASKS_WORK, "hospital")
  async done(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await completeTask(this.db, actor, { ...body(b), taskId: id })));
  }

  /** The door admits a worker too: a kind may name its own `verifierPermission`, which the intent checks. */
  @Post(":id/verify")
  @RequirePermission(TASKS_SUPERVISE, "hospital", { alsoAdmits: [TASKS_WORK] })
  async verify(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await verifyTask(this.db, actor, { ...body(b), taskId: id })));
  }

  @Post(":id/cancel")
  @RequirePermission(TASKS_SUPERVISE, "hospital")
  async cancel(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    return refusing(async () => ack(await cancelTask(this.db, actor, { ...body(b), taskId: id })));
  }

  @Post(":id/return")
  @RequirePermission(TASKS_WORK, "hospital", { alsoAdmits: [TASKS_SUPERVISE] })
  async giveBack(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() b: unknown): Promise<Ack> {
    const asSupervisor = await this.supervisor(actor);
    return refusing(async () => ack(await returnToPool(this.db, actor, { ...body(b), taskId: id }, new Date(), { asSupervisor })));
  }
}
