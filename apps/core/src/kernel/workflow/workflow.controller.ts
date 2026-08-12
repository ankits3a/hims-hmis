import {
  BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, Inject,
  Param, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { SodViolationError } from "../auth/sod";
import { WorkflowValidationError } from "./definition";
import {
  createDraft, approveDefinition, activateDefinition, listDefinitions, GovernanceError,
} from "./definitions";
import { WorkflowError } from "./instances";
import type { DefinitionRow } from "./definitions";
import type { Db } from "../db/client";

/** Engine errors → HTTP. Anything unrecognized rethrows: a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof WorkflowValidationError) throw new BadRequestException(e.problems);
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof GovernanceError) throw new ConflictException(e.message);
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

@Controller("workflow")
export class WorkflowController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("workflow.definitions.draft", "hospital")
  @Post("definitions")
  async draft(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ definitionId: string; defKey: string; version: number }> {
    try {
      return await createDraft(this.db, actor, body);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.definitions.approve", "hospital")
  @Post("definitions/:id/approve")
  async approve(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = z
      .object({ roleKey: z.string().min(1), note: z.string().min(3), emergency: z.boolean().optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      await approveDefinition(this.db, actor, { definitionId: id, ...parsed.data });
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.definitions.activate", "hospital")
  @Post("definitions/:id/activate")
  async activate(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
  ): Promise<{ retiredVersion: number | null }> {
    try {
      return await activateDefinition(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.definitions.read", "hospital")
  @Get("definitions")
  async list(@Query("key") key: string | undefined): Promise<{ definitions: DefinitionRow[] }> {
    if (typeof key !== "string" || key === "") throw new BadRequestException("query param key is required");
    return { definitions: await listDefinitions(this.db, key) };
  }
}
