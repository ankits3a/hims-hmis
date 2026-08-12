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
import { and, eq, isNull } from "drizzle-orm";
import { withTx } from "../db/client";
import { startInstance, transition } from "./instances";
import { migrateInstance, abortInstance } from "./remediation";
import { workflowInstances, workflowTransitions, workflowTimers } from "../db/schema";

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

  @RequirePermission("workflow.instances.start", "hospital")
  @Post("instances")
  async start(@Body() body: unknown): Promise<{ instanceId: string; state: string }> {
    const parsed = z
      .object({
        defKey: z.string().min(1),
        subject: z.object({
          type: z.string().min(1),
          id: z.string().min(1),
          patientId: z.string().optional(),
          encounterId: z.string().optional(),
        }),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await withTx(this.db, (tx) => startInstance(tx, parsed.data.defKey, parsed.data.subject));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.instances.transition", "hospital")
  @Post("instances/:id/transition")
  async doTransition(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ state: string; completed: boolean }> {
    const parsed = z.object({ to: z.string().min(1), note: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await withTx(this.db, (tx) =>
        transition(tx, id, parsed.data.to, actor, { note: parsed.data.note }),
      );
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.instances.read", "hospital")
  @Get("instances/:id")
  async instanceDetail(@Param("id") id: string): Promise<{
    instance: typeof workflowInstances.$inferSelect;
    transitions: (typeof workflowTransitions.$inferSelect)[];
    openTimers: (typeof workflowTimers.$inferSelect)[];
  }> {
    const rows = await this.db.select().from(workflowInstances).where(eq(workflowInstances.id, id));
    const instance = rows[0];
    if (!instance) throw new BadRequestException(`unknown instance ${id}`);
    const transitions = await this.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.instanceId, id))
      .orderBy(workflowTransitions.at);
    const openTimers = await this.db
      .select()
      .from(workflowTimers)
      .where(and(eq(workflowTimers.instanceId, id), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt)));
    return { instance, transitions, openTimers };
  }

  @RequirePermission("workflow.instances.remediate", "hospital")
  @Post("instances/:id/migrate")
  async migrate(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ toDefinitionId: string; toVersion: number; state: string }> {
    const parsed = z
      .object({ stateMapping: z.record(z.string(), z.string()), reason: z.string().min(3) })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await migrateInstance(this.db, actor, { instanceId: id, ...parsed.data });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("workflow.instances.remediate", "hospital")
  @Post("instances/:id/abort")
  async abort(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = z.object({ reason: z.string().min(3) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      await abortInstance(this.db, actor, { instanceId: id, ...parsed.data });
      return { ok: true };
    } catch (e) {
      toHttp(e);
    }
  }
}
