import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { Actor, WireBriefs, WireTower } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed } from "../../kernel/desk/http";
import { toHttp } from "./errors";
import { towerView } from "./tower";
import { nudge } from "./nudge";
import { listBriefs, markBriefSeen } from "./briefs";
import { unitOfOn } from "./scope";
import { istDateOfInstant } from "../roster";
import type { Db } from "../../kernel/db/client";

/**
 * DD-0 (#626) — the Doctor Desk's four routes. The door is the doctor's existing `opd.consult` grant
 * (spec DECIDED 2: no new permission); every act re-checks the unit inside the domain call, and every
 * read is the asker's own (no user id in any path — the `/me` rule).
 */
const nudgeBody = z.object({ rowKey: z.string().min(3).max(120).regex(/^(alert|lab_critical|visit):[A-Za-z0-9_-]+$/) }).strict();
const briefId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

@Controller("doctor-desk")
export class DoctorDeskController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("tower")
  @RequirePermission("opd.consult", "hospital")
  async tower(@CurrentActor() actor: Actor): Promise<WireTower> {
    try { return await towerView(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-0.1 (R5) — whether `/` should send this doctor to the Tower: they hold a unit membership today. */
  @Get("landing")
  @RequirePermission("opd.consult", "hospital")
  async landing(@CurrentActor() actor: Actor): Promise<{ tower: boolean }> {
    const at = new Date();
    return { tower: actor.type === "user" && (await unitOfOn(this.db, actor.id, istDateOfInstant(at))) !== null };
  }

  @Post("clocks/nudge")
  @HttpCode(200)
  @RequirePermission("opd.consult", "hospital")
  async nudge(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ nudgeId: string }> {
    const { rowKey } = parsed(nudgeBody, body);
    try { return { nudgeId: (await nudge(this.db, actor, rowKey, new Date())).nudgeId }; } catch (e) { toHttp(e); }
  }

  @Get("briefs")
  @RequirePermission("opd.consult", "hospital")
  async briefs(@CurrentActor() actor: Actor): Promise<WireBriefs> {
    try { return { briefs: await listBriefs(this.db, actor, new Date()) }; } catch (e) { toHttp(e); }
  }

  @Post("briefs/:id/seen")
  @HttpCode(204)
  @RequirePermission("opd.consult", "hospital")
  async seen(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<void> {
    try { await markBriefSeen(this.db, actor, parsed(briefId, id), new Date()); } catch (e) { toHttp(e); }
  }
}
