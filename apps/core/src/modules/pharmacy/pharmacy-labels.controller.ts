import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { DB } from "../../kernel/tokens";
import { idSchema, parsed, toHttp } from "./pharmacy-http";
import { LABELS_PERMISSION, MAX_COPIES, labelCandidates, sendLabels } from "./labels";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { LabelCandidate, SendLabelsResult } from "./labels";

/**
 * GAP A6 — the office's "Rack & strip labels" (board `2026-09-28-pharmacy-office`, Items side). The
 * screen picks from a store's items, then asks for a print; with no relay serving the label printer
 * the rendered stickers come back for the browser to print.
 */
const candidatesQuery = z.object({ store: idSchema.optional(), q: z.string().max(80).default("") });
const printBody = z.object({
  kind: z.enum(["rack", "strip"]),
  storeResourceId: idSchema,
  lines: z.array(z.object({
    itemId: idSchema,
    batchId: idSchema.nullable().optional(),
    packUom: z.string().trim().min(1).max(32).nullable().optional(),
    copies: z.number().int().min(1).max(MAX_COPIES),
  })).min(1).max(300),
});

@Controller("pharmacy/labels")
export class PharmacyLabelsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(LABELS_PERMISSION, "hospital")
  @Get()
  async candidates(@Query() query: unknown): Promise<{ stores: { id: string; code: string; name: string }[]; rows: LabelCandidate[] }> {
    const { store, q } = parsed(candidatesQuery, query);
    try { return await labelCandidates(this.db, store ?? null, q); } catch (e) { return toHttp(e); }
  }

  @RequirePermission(LABELS_PERMISSION, "hospital")
  @Post("print")
  async print(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<SendLabelsResult> {
    const input = parsed(printBody, body);
    try { return await sendLabels(this.db, actor, input, new Date()); } catch (e) { return toHttp(e); }
  }
}
