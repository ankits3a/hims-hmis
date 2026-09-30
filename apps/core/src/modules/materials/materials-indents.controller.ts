import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { MaterialsError } from "./errors";
import { cancelIndent, getIndent, issueIndent, listIndents, raiseIndent, rejectIndent } from "./indents";
import { toHttp } from "./materials.controller";
import type { IndentView } from "./indents";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PHARMACY GAP A6b — the indent's HTTP surface. The requesting side raises and cancels
 * (`materials.stock.receive`), the supplying side issues and rejects (`materials.stock.issue`), and
 * reads are `materials.stock.read`: the transfer routes' three grants, no new one. Every refusal goes
 * through the materials controller's `toHttp`, so a `MaterialsError` never answers 500.
 */
function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

const id = z.string().min(1).max(64);
const qty = z.number().int();
const reasonBody = z.object({ reason: z.string().max(500) });
const raiseBody = z.object({
  fromResourceId: id, toResourceId: id, note: z.string().max(500).nullish(),
  lines: z.array(z.object({ itemId: id, qtyBase: qty })).max(200),
});
const issueBody = z.object({ lines: z.array(z.object({ lineIdx: z.number().int().nonnegative(), qtyBase: qty })).max(200).optional() });

@Controller("materials/indents")
export class MaterialsIndentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission("materials.stock.read", "hospital")
  @Get()
  async list(@Query() query: unknown): Promise<{ indents: IndentView[] }> {
    const q = parsed(z.object({ storeId: id.optional(), status: z.enum(["requested", "issued", "rejected", "cancelled"]).optional() }), query);
    return { indents: await listIndents(this.db, q) };
  }

  @RequirePermission("materials.stock.read", "hospital")
  @Get(":id")
  async one(@Param("id") indentId: string): Promise<{ indent: IndentView }> {
    const indent = await getIndent(this.db, indentId);
    if (indent === undefined) toHttp(new MaterialsError("unknown_indent", `indent ${indentId} not found`));
    return { indent };
  }

  @RequirePermission("materials.stock.receive", "hospital")
  @Post()
  async raise(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ indent: IndentView }> {
    const b = parsed(raiseBody, body);
    try {
      return { indent: await raiseIndent(this.db, actor, b) };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.stock.issue", "hospital")
  @Post(":id/issue")
  async issue(@CurrentActor() actor: Actor, @Param("id") indentId: string, @Body() body: unknown): Promise<{ indent: IndentView }> {
    const b = parsed(issueBody, body ?? {});
    try {
      return { indent: await issueIndent(this.db, actor, indentId, b) };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.stock.issue", "hospital")
  @Post(":id/reject")
  async reject(@CurrentActor() actor: Actor, @Param("id") indentId: string, @Body() body: unknown): Promise<{ indent: IndentView }> {
    const b = parsed(reasonBody, body);
    try {
      return { indent: await rejectIndent(this.db, actor, indentId, b.reason) };
    } catch (e) { toHttp(e); }
  }

  @RequirePermission("materials.stock.receive", "hospital")
  @Post(":id/cancel")
  async cancel(@CurrentActor() actor: Actor, @Param("id") indentId: string, @Body() body: unknown): Promise<{ indent: IndentView }> {
    const b = parsed(reasonBody, body);
    try {
      return { indent: await cancelIndent(this.db, actor, indentId, b.reason) };
    } catch (e) { toHttp(e); }
  }
}
