import { Body, Controller, Get, Header, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { STORES_MASTERS } from "./access";
import { STORES_TOWER_READ } from "./tower";
import { acceptParSuggestion, keepParSuggestion, parSuggestions } from "./par-suggestions";
import {
  approvePlannerT3, departmentPlannerScore, myTopUps, notNowTopUp, plannerMonthlyLine, plannerSettingsView, plannerTrail, returnSlowStock, sendTopUp,
  setPlannerSettings, topUpProposal,
} from "./planner";
import { STORES_PLANNER_MANAGE } from "./planner-core";
import { stockOutsWithoutWarning } from "./planner-score";
import { parsed, toHttp } from "./stores-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const id = z.string().min(1).max(64);
const qty = z.number().int().positive().max(10_000_000);
const level = z.number().int().min(0).max(10_000_000);
const parBody = z.object({ minBase: level, reorderBase: level, maxBase: level });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional();
const days = z.number().int().min(0).max(365);

/**
 * STORES S7 (#1117) — the stock planner (`/stores/planner/*`). The top-up proposal and its acts carry no route grant: the
 * department is a fact of the draft's shelf, asked inside the intent (S1's shelf-route rule). Par suggestions are the
 * materials head's (`stores.masters.manage`), the settings the planner manager's (`stores.planner.manage`); the owner's T3
 * approval asks the owner role inside the intent; the stock-outs list is the tower's readers'.
 */
@Controller("stores/planner")
export class StoresPlannerController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("topup")
  @Header("Cache-Control", "no-store")
  async topUps(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await myTopUps(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Get("topup/:departmentId")
  @Header("Cache-Control", "no-store")
  async topUp(@CurrentActor() actor: Actor, @Param("departmentId") departmentId: string): Promise<unknown> {
    try { return await topUpProposal(this.db, actor, parsed(id, departmentId)); } catch (e) { toHttp(e); }
  }

  @Post("drafts/:draftId/send")
  async send(@CurrentActor() actor: Actor, @Param("draftId") draftId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(z.object({ lines: z.array(z.object({ itemId: id, qty })).max(200).optional() }), body ?? {});
    try {
      const r = await sendTopUp(this.db, actor, parsed(id, draftId), b.lines === undefined ? {} : { lines: b.lines });
      return { ticket: { id: r.ticket.id, indentNo: r.ticket.indentNo, stage: r.ticket.stage }, actId: r.actId };
    } catch (e) { toHttp(e); }
  }

  @Post("drafts/:draftId/not-now")
  async notNow(@CurrentActor() actor: Actor, @Param("draftId") draftId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(z.object({ reason: z.string().max(40).nullish() }), body ?? {});
    try { return await notNowTopUp(this.db, actor, parsed(id, draftId), b.reason ?? null); } catch (e) { toHttp(e); }
  }

  @Post("drafts/:draftId/return")
  async giveBack(@CurrentActor() actor: Actor, @Param("draftId") draftId: string): Promise<unknown> {
    try { return await returnSlowStock(this.db, actor, parsed(id, draftId)); } catch (e) { toHttp(e); }
  }

  @Get("par-suggestions")
  @Header("Cache-Control", "no-store")
  @RequirePermission(STORES_MASTERS, "hospital")
  async pars(@CurrentActor() actor: Actor, @Query("all") all?: string): Promise<unknown> {
    try { return await parSuggestions(this.db, actor, new Date(), { all: all === "1" }); } catch (e) { toHttp(e); }
  }

  @Post("par-suggestions/:suggestionId/accept")
  @RequirePermission(STORES_MASTERS, "hospital")
  async accept(@CurrentActor() actor: Actor, @Param("suggestionId") suggestionId: string, @Body() body: unknown): Promise<unknown> {
    const b = parsed(z.object({ edit: parBody.nullish() }), body ?? {});
    try { return await acceptParSuggestion(this.db, actor, parsed(id, suggestionId), b.edit ?? null); } catch (e) { toHttp(e); }
  }

  @Post("par-suggestions/:suggestionId/keep")
  @RequirePermission(STORES_MASTERS, "hospital")
  async keep(@CurrentActor() actor: Actor, @Param("suggestionId") suggestionId: string): Promise<unknown> {
    try { return await keepParSuggestion(this.db, actor, parsed(id, suggestionId)); } catch (e) { toHttp(e); }
  }

  @Get("monthly")
  @Header("Cache-Control", "no-store")
  async monthly(@CurrentActor() actor: Actor, @Query("month") m?: string): Promise<unknown> {
    try { return await plannerMonthlyLine(this.db, actor, parsed(month, m)); } catch (e) { toHttp(e); }
  }

  @Get("trail")
  @Header("Cache-Control", "no-store")
  async trail(@CurrentActor() actor: Actor, @Query("shelfId") shelfId?: string, @Query("itemId") itemId?: string): Promise<unknown> {
    try { return await plannerTrail(this.db, actor, parsed(id, shelfId), parsed(id, itemId)); } catch (e) { toHttp(e); }
  }

  @Get("stock-outs")
  @Header("Cache-Control", "no-store")
  @RequirePermission(STORES_TOWER_READ, "hospital")
  async stockOuts(@Query("days") d?: string): Promise<unknown> {
    const n = parsed(days, d === undefined ? 30 : Number(d));
    const to = new Date();
    return stockOutsWithoutWarning(this.db, new Date(to.getTime() - n * 86_400_000), to);
  }

  @Get("settings")
  @Header("Cache-Control", "no-store")
  @RequirePermission(STORES_PLANNER_MANAGE, "hospital")
  async settings(@Query("departmentId") departmentId?: string): Promise<unknown> {
    try { return await plannerSettingsView(this.db, departmentId === undefined || departmentId === "" ? null : parsed(id, departmentId)); } catch (e) { toHttp(e); }
  }

  @Post("settings")
  @RequirePermission(STORES_PLANNER_MANAGE, "hospital")
  async setSettings(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const b = parsed(z.object({
      departmentId: id.nullish(), paused: z.boolean().optional(), t3: z.boolean().optional(),
      safetyDays: z.object({ V: days, E: days, D: days }).optional(), coverDays: z.object({ A: days, B: days, C: days }).optional(),
      reason: z.string().trim().max(300).nullish(),
    }), body ?? {});
    try { return await setPlannerSettings(this.db, actor, b); } catch (e) { toHttp(e); }
  }

  @Post("t3/:departmentId/approve")
  async approveT3(@CurrentActor() actor: Actor, @Param("departmentId") departmentId: string): Promise<unknown> {
    try { return await approvePlannerT3(this.db, actor, parsed(id, departmentId)); } catch (e) { toHttp(e); }
  }

  @Get("score/:departmentId")
  @Header("Cache-Control", "no-store")
  async score(@CurrentActor() actor: Actor, @Param("departmentId") departmentId: string): Promise<unknown> {
    try { return await departmentPlannerScore(this.db, actor, parsed(id, departmentId)); } catch (e) { toHttp(e); }
  }
}
