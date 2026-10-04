import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { onNowBoard } from "./board";
import { toHttp } from "./roster-http";
import {
  acceptUnitFinding, draftUnitMonth, editSlot, publishUnitMonth, rosterUnits, unitMonth,
  rosterSelf,
} from "./month";
import type { RosterSelf, RosterUnitsDepartment, UnitMonth } from "./month";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OnNowBoard } from "./board";
import { withTx } from "../../kernel/db/client";
import { boardAsItStood } from "./as-it-stood";
import type { AsItStoodBoard } from "./as-it-stood";
import { declarationsView, declareHolidayAct, declareModeAct, withdrawModeAct } from "./declarations";
import type { DeclarationsView } from "./declarations";

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
  async onNow(@CurrentActor() actor: Actor, @Query("at") at?: string): Promise<OnNowBoard & { you: RosterSelf }> {
    try {
      const instant = at === undefined || at === "" ? new Date() : new Date(at);
      if (Number.isNaN(instant.getTime())) {
        throw new RosterError("invalid_window", "`at` is not an instant — send an ISO date-time", { at });
      }
      await requireRosterAct(this.db, actor, "read");
      // `you` — the reader, for the Doctor Desk header (`rosterSelf`); additive.
      return { ...(await onNowBoard(this.db, instant)), you: await rosterSelf(this.db, actor, new Date()) };
    } catch (e) { toHttp(e); }
  }

  /* ═══ 20-U U5b — ROSTER: THE UNIT'S MONTH ═══
   *
   * The route's door is `roster.read` at hospital scope, as `on-now`'s: every route census reads it,
   * and the house guard cannot see a department through a team or a period id. **The real guard is
   * the act, at the unit's own department**, asked inside the domain function each route calls —
   * `propose`/`edit_human_draft` (`roster.periods.manage`), `accept_warning` and `publish`
   * (`roster.periods.publish`). A reader who holds neither reaches the door and is refused at the act
   * (`not_permitted`, 403); `test/roster-month.e2e.test.ts` pins that. Every write answers with the
   * month as it now stands, so the screen never renders a guess.
   */

  /** The departments that run units, and their units — the screen's unit picker. */
  @Get("units")
  @RequirePermission("roster.read", "hospital")
  async units(@CurrentActor() actor: Actor): Promise<RosterUnitsDepartment[]> {
    try {
      await requireRosterAct(this.db, actor, "read");
      return await rosterUnits(this.db);
    } catch (e) { toHttp(e); }
  }

  /** One unit's month (`YYYY-MM`, IST): the period, its slots, the findings as the gate sees them. */
  @Get("units/:teamId/months/:month")
  @RequirePermission("roster.read", "hospital")
  async month(@CurrentActor() actor: Actor, @Param("teamId") teamId: string, @Param("month") month: string): Promise<UnitMonth> {
    try {
      return await unitMonth(this.db, actor, teamId, month);
    } catch (e) { toHttp(e); }
  }

  /** Ask the proposer to draft the month. Idempotent: a month already in hand is returned as it is. */
  @Post("units/:teamId/months/:month/draft")
  @HttpCode(200)
  @RequirePermission("roster.read", "hospital")
  async draft(@CurrentActor() actor: Actor, @Param("teamId") teamId: string, @Param("month") month: string): Promise<UnitMonth> {
    try {
      return await draftUnitMonth(this.db, actor, teamId, month);
    } catch (e) { toHttp(e); }
  }

  /** One slot, a different person — `userId: null` leaves it vacant (a declared hole). */
  @Put("slots/:assignmentId")
  @RequirePermission("roster.read", "hospital")
  async slot(@CurrentActor() actor: Actor, @Param("assignmentId") assignmentId: string, @Body() body: unknown): Promise<UnitMonth> {
    try {
      const b = (body ?? {}) as { userId?: unknown };
      if (!("userId" in b) || (b.userId !== null && (typeof b.userId !== "string" || b.userId === ""))) {
        throw new RosterError("invalid_window", "say who takes this duty — a member of staff's id, or null to leave it vacant", {});
      }
      const ref = await editSlot(this.db, actor, assignmentId, b.userId);
      return await unitMonth(this.db, actor, ref.teamId, ref.month);
    } catch (e) { toHttp(e); }
  }

  /** A named person accepts one finding, with a reason. `accept_warning` at the department. */
  @Post("periods/:periodId/findings/accept")
  @HttpCode(200)
  @RequirePermission("roster.read", "hospital")
  async accept(@CurrentActor() actor: Actor, @Param("periodId") periodId: string, @Body() body: unknown): Promise<UnitMonth> {
    try {
      const b = (body ?? {}) as Record<string, unknown>;
      const idOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v !== "");
      if (typeof b.ruleKey !== "string" || !idOrNull(b.assignmentId) || !idOrNull(b.userId) || typeof b.reason !== "string") {
        throw new RosterError("invalid_window", "name the finding (rule, duty, person) and give a reason for accepting it", {});
      }
      const ref = await acceptUnitFinding(this.db, actor, periodId, {
        ruleKey: b.ruleKey, assignmentId: b.assignmentId, userId: b.userId,
      }, b.reason);
      return await unitMonth(this.db, actor, ref.teamId, ref.month);
    } catch (e) { toHttp(e); }
  }

  /** Publish the draft the person read: `expectedContentHash` is the hash the month read gave them (V4). */
  @Post("periods/:periodId/publish")
  @HttpCode(200)
  @RequirePermission("roster.read", "hospital")
  async publish(@CurrentActor() actor: Actor, @Param("periodId") periodId: string, @Body() body: unknown): Promise<UnitMonth> {
    try {
      const b = (body ?? {}) as { expectedContentHash?: unknown };
      if (typeof b.expectedContentHash !== "string" || b.expectedContentHash === "") {
        throw new RosterError("invalid_window", "publish the roster you read — send the content hash the month was shown with", {});
      }
      const ref = await publishUnitMonth(this.db, actor, periodId, b.expectedContentHash);
      return await unitMonth(this.db, actor, ref.teamId, ref.month);
    } catch (e) { toHttp(e); }
  }
  /* ═══ 20-U I23 — THE BOARD AS IT STOOD ═══
   *
   * `GET /roster/as-it-stood?at=<ISO instant>` — the roster AS PUBLISHED at that instant (the
   * knowledge axis, `as-it-stood.ts`), never the rows in effect today, and every change made to that
   * day since. A read: `roster.read` at the door, `read` at the act, as `on-now`.
   */
  @Get("as-it-stood")
  @RequirePermission("roster.read", "hospital")
  async asItStood(@CurrentActor() actor: Actor, @Query("at") at?: string): Promise<AsItStoodBoard & { you: RosterSelf }> {
    try {
      const instant = at === undefined || at === "" ? new Date(Number.NaN) : new Date(at);
      if (Number.isNaN(instant.getTime())) {
        throw new RosterError("invalid_window", "`at` is not an instant — send an ISO date-time", { at });
      }
      await requireRosterAct(this.db, actor, "read");
      const now = new Date();
      return { ...(await boardAsItStood(this.db, instant, now)), you: await rosterSelf(this.db, actor, now) };
    } catch (e) { toHttp(e); }
  }

  /* ═══ 20-U I1 / I2 / I5 — HOLIDAYS AND SKELETON COVER, DECLARED ═══
   *
   * The read is the next thirty days' declarations and what this reader may declare; each act
   * answers with the same read. The door is `roster.read` (as every roster route); the act is
   * `declare` (`roster.periods.publish`, MS or a named delegate), asked by the domain function —
   * a reader is refused there with `not_permitted` (403).
   */
  @Get("declarations")
  @RequirePermission("roster.read", "hospital")
  async declarations(@CurrentActor() actor: Actor): Promise<DeclarationsView> {
    try {
      return await declarationsView(this.db, actor, new Date());
    } catch (e) { toHttp(e); }
  }

  @Post("holidays")
  @HttpCode(200)
  @RequirePermission("roster.read", "hospital")
  async declareHoliday(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<DeclarationsView> {
    try {
      const b = (body ?? {}) as Record<string, unknown>;
      const now = new Date();
      await withTx(this.db, (tx) => declareHolidayAct(tx, actor, { istDate: b.istDate, kind: b.kind, pattern: b.pattern }, now));
      return await declarationsView(this.db, actor, now);
    } catch (e) { toHttp(e); }
  }

  @Post("modes")
  @HttpCode(200)
  @RequirePermission("roster.read", "hospital")
  async declareMode(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<DeclarationsView> {
    try {
      const b = (body ?? {}) as Record<string, unknown>;
      const now = new Date();
      await withTx(this.db, (tx) => declareModeAct(tx, actor, { departmentId: b.departmentId ?? null, istDate: b.istDate, reason: b.reason }, now));
      return await declarationsView(this.db, actor, now);
    } catch (e) { toHttp(e); }
  }

  @Post("modes/:declarationId/withdraw")
  @HttpCode(200)
  @RequirePermission("roster.read", "hospital")
  async withdrawMode(@CurrentActor() actor: Actor, @Param("declarationId") declarationId: string, @Body() body: unknown): Promise<DeclarationsView> {
    try {
      const b = (body ?? {}) as Record<string, unknown>;
      await withTx(this.db, (tx) => withdrawModeAct(tx, actor, declarationId, { reason: b.reason }));
      return await declarationsView(this.db, actor, new Date());
    } catch (e) { toHttp(e); }
  }
}
