import {
  BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, Inject,
  NotFoundException, Param, Post, Query,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { SodViolationError } from "../auth/sod";
import { withTx } from "../db/client";
import { WorkflowError } from "../workflow/instances";
import { ApprovalError, registerApprovalType } from "./types";
import { requestApproval } from "./requests";
import { approveRequest, rejectRequest } from "./decisions";
import { listApprovals, getApproval } from "./worklist";
import type { ApprovalRow } from "./worklist";
import type { Db } from "../db/client";

/** Approvals errors → HTTP, defined once (Plan 03's toHttp convention). Anything unrecognized rethrows: a 500 is a genuine bug, loudly. */
function toHttp(e: unknown): never {
  if (e instanceof SodViolationError) throw new ForbiddenException(e.message);
  if (e instanceof ApprovalError) {
    if (e.code === "unknown_approval") throw new NotFoundException(e.message);
    if (e.code === "not_pending") throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  // Plan 03's established mapping — covers role_denied and stale_transition from transition().
  if (e instanceof WorkflowError) throw new ConflictException(e.message);
  throw e;
}

const urgencyEnum = z.enum(["routine", "urgent", "emergency"]);

const typeBody = z.object({
  typeKey: z.string().min(1),
  title: z.string().min(1),
  approverRole: z.string().min(1),
  urgencyClass: urgencyEnum.optional(),
  actFirstAllowed: z.boolean().optional(),
});

const requestBody = z.object({
  typeKey: z.string().min(1),
  subject: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  patientId: z.string().min(1).optional(),
  encounterId: z.string().min(1).optional(),
  payeeId: z.string().min(1).optional(),
  amountPaise: z.number().int().positive().optional(),
  requestNote: z.string().optional(),
  actFirst: z.boolean().optional(),
});

const decisionBody = z.object({ note: z.string().min(1) }); // whitespace-only still passes here — T5 refuses it at runtime

const worklistQuery = z.object({
  status: z.enum(["pending", "granted", "rejected"]).optional(),
  typeKey: z.string().optional(),
  urgencyClass: urgencyEnum.optional(),
  approverRole: z.string().optional(),
  olderThanMinutes: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

@Controller("approvals")
export class ApprovalsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Literal segment declared BEFORE the :id routes — Nest matches in declaration order.
  @RequirePermission("approvals.types.manage", "hospital")
  @Post("types")
  async registerType(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ typeKey: string; defKey: string }> {
    const parsed = typeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await registerApprovalType(this.db, actor, parsed.data);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.create", "hospital")
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ approvalId: string; instanceId: string }> {
    const parsed = requestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await withTx(this.db, (tx) => requestApproval(tx, actor, parsed.data));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.read", "hospital")
  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ items: ApprovalRow[]; total: number }> {
    const parsed = worklistQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await listApprovals(this.db, actor, parsed.data);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.read", "hospital")
  @Get(":id")
  async detail(@Param("id") id: string): Promise<{ approval: ApprovalRow }> {
    const approval = await getApproval(this.db, id);
    if (!approval) throw new NotFoundException(`unknown approval ${id}`);
    return { approval };
  }

  @RequirePermission("approvals.requests.decide", "hospital")
  @Post(":id/approve")
  async approve(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ status: "granted" }> {
    const parsed = decisionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await approveRequest(this.db, actor, { approvalId: id, note: parsed.data.note });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("approvals.requests.decide", "hospital")
  @Post(":id/reject")
  async reject(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ status: "rejected" }> {
    const parsed = decisionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    try {
      return await rejectRequest(this.db, actor, { approvalId: id, note: parsed.data.note });
    } catch (e) {
      toHttp(e);
    }
  }
}
