import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Inject, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../tokens";
import { CurrentActor, RequirePermission } from "../auth/decorators";
import { hasPermission } from "../auth/permissions";
import { COPILOT_HALT_SCOPES } from "../db/schema";
import { clearHalt, setHalt } from "./halt";
import type { Db } from "../db/client";
import type { Actor } from "@hmis/contracts";

/**
 * E0.3 — THE HALT SWITCH'S TWO DOORS (plan E0.3, decision 0064; spec
 * /opt/hmis-context/SPEC-copilot-halt-and-cap-2026-10-11.md). Buttons on /copilot-health call these.
 *
 *   halt                  `copilot.halt.set`          owner, IT (admin), the steward, the duty manager
 *   clear read/act/draft  `copilot.halt.clear`        owner, the duty manager (plan: a false 2 a.m. halt
 *                                                     must not wait till morning)
 *   clear global          `copilot.halt.clear_global` owner only
 *
 * Halting is easy and clearing is narrow, on purpose: a wrong halt costs the desk its long tail for
 * an hour; a wrong clear lets a misbehaving copilot keep acting.
 */
export const COPILOT_HALT_SET = "copilot.halt.set";
export const COPILOT_HALT_CLEAR = "copilot.halt.clear";
export const COPILOT_HALT_CLEAR_GLOBAL = "copilot.halt.clear_global";

const haltBody = z.object({
  scope: z.enum(COPILOT_HALT_SCOPES),
  reason: z.string().trim().min(1).max(200).optional(),
});
const clearBody = z.object({ scope: z.enum(COPILOT_HALT_SCOPES) });

@Controller("copilot/halt")
export class CopilotHaltController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post()
  @HttpCode(200)
  @RequirePermission(COPILOT_HALT_SET, "hospital")
  async halt(@CurrentActor() actor: Actor, @Body() raw: unknown): Promise<{ scope: string; halted: true; changed: boolean }> {
    const b = haltBody.safeParse(raw);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "invalid body");
    const { changed } = await setHalt(this.db, actor, b.data.scope, b.data.reason ?? null);
    return { scope: b.data.scope, halted: true, changed };
  }

  @Post("clear")
  @HttpCode(200)
  @RequirePermission(COPILOT_HALT_CLEAR, "hospital", { alsoAdmits: [COPILOT_HALT_CLEAR_GLOBAL] })
  async clear(@CurrentActor() actor: Actor, @Body() raw: unknown): Promise<{ scope: string; halted: false; changed: boolean }> {
    const b = clearBody.safeParse(raw);
    if (!b.success) throw new BadRequestException(b.error.issues[0]?.message ?? "invalid body");
    const needs = b.data.scope === "global" ? COPILOT_HALT_CLEAR_GLOBAL : COPILOT_HALT_CLEAR;
    if (!(await hasPermission(this.db, actor.id, needs, "hospital"))) {
      throw new ForbiddenException(`clearing the ${b.data.scope} halt needs ${needs}`);
    }
    const { changed } = await clearHalt(this.db, actor, b.data.scope);
    return { scope: b.data.scope, halted: false, changed };
  }
}
