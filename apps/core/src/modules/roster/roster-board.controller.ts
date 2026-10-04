import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { onNowBoard } from "./board";
import { toHttp } from "./roster-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OnNowBoard } from "./board";

/**
 * 20-U U5a — **WHO IS ON NOW**, over HTTP. The roster module's first route.
 *
 * `GET /roster/on-now?at=<ISO instant>` — `at` defaults to the server's now. The screen shows now
 * and refreshes; `at` exists so "now / +8 h" and "who was on at 03:10 that night" are the same
 * question (the resolver's rule: the clock is the caller's).
 *
 * Guarded twice, the house way and the roster's way: `RequirePermission("roster.read", "hospital")`
 * is the route's guard every census reads, and `requireRosterAct(…, "read")` adds the act matrix
 * (V8 — what KIND of actor may read at all). The board names every unit-running department, so the
 * read is hospital-scoped.
 */
@Controller("roster")
export class RosterBoardController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("on-now")
  @RequirePermission("roster.read", "hospital")
  async onNow(@CurrentActor() actor: Actor, @Query("at") at?: string): Promise<OnNowBoard> {
    try {
      const instant = at === undefined || at === "" ? new Date() : new Date(at);
      if (Number.isNaN(instant.getTime())) {
        throw new RosterError("invalid_window", "`at` is not an instant — send an ISO date-time", { at });
      }
      await requireRosterAct(this.db, actor, "read");
      return await onNowBoard(this.db, instant);
    } catch (e) { toHttp(e); }
  }
}
