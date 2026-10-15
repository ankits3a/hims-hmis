import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { RosterError } from "./errors";
import { toHttp } from "./roster-http";
import { cancelOwnLeave, decideLeave, fileOwnLeave, leaveToDecide, myLeave } from "./leave";
import type { LeaveToDecideView, MyLeaveView } from "./leave";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ E2.2 — MY LEAVE (owner 2026-10-11) ═══
 *
 * NO `@RequirePermission` ON THE PERSON'S OWN ROUTES, DELIBERATELY: a junior resident or a ward
 * nurse asking for two days holds no roster string and must not need one (`policy.ts`'
 * `request_absence: open`). Every route acts on the reader's OWN rows only — `leave.ts` takes the
 * user id from the actor, never from the body. The decider's two routes check the roster's
 * `publish` act per request inside `leave.ts` / `absences.ts`, as every roster act does.
 */
@Controller("roster/leave")
export class LeaveController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("mine")
  async mine(@CurrentActor() actor: Actor): Promise<MyLeaveView[]> {
    try { return await myLeave(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post()
  @HttpCode(200)
  async file(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ absenceId: string }> {
    try {
      const b = (body ?? {}) as Record<string, unknown>;
      const str = (v: unknown): v is string => typeof v === "string" && v.length <= 32;
      if (!str(b.kind) || !str(b.from) || !str(b.to) || (b.reason !== undefined && b.reason !== null && typeof b.reason !== "string")) {
        throw new RosterError("invalid_window", "name the kind of leave, its first day and its last day", {});
      }
      return await withTx(this.db, (tx) => fileOwnLeave(tx, actor, {
        kind: b.kind as string, from: b.from as string, to: b.to as string, reason: typeof b.reason === "string" ? b.reason : null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post(":absenceId/cancel")
  @HttpCode(200)
  async cancel(@CurrentActor() actor: Actor, @Param("absenceId") absenceId: string): Promise<{ ok: true }> {
    try {
      await withTx(this.db, (tx) => cancelOwnLeave(tx, actor, absenceId));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }

  /** The requests waiting for this reader's decision — empty for anybody who decides none. */
  @Get("to-decide")
  async toDecide(@CurrentActor() actor: Actor): Promise<LeaveToDecideView[]> {
    try { return await leaveToDecide(this.db, actor); } catch (e) { toHttp(e); }
  }

  @Post(":absenceId/decide")
  @HttpCode(200)
  async decide(@CurrentActor() actor: Actor, @Param("absenceId") absenceId: string, @Body() body: unknown): Promise<{ ok: true }> {
    try {
      const b = (body ?? {}) as { approve?: unknown; note?: unknown };
      if (typeof b.approve !== "boolean" || (b.note !== undefined && b.note !== null && typeof b.note !== "string")) {
        throw new RosterError("invalid_window", "approve or refuse — `approve: true` or `approve: false` with a reason", {});
      }
      await withTx(this.db, (tx) => decideLeave(tx, actor, absenceId, { approve: b.approve as boolean, note: typeof b.note === "string" ? b.note : null }));
      return { ok: true };
    } catch (e) { toHttp(e); }
  }
}
