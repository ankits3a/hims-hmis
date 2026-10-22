import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { ACT_CHOICES, ACT_NOTE_MAX, RATING_REASON_MAX, WORK_RATINGS } from "@hmis/contracts";
import type { Actor, WireBriefs, WireMyRatings, WireUnitReports, WireNextCard, WireNow, WireOpdDesk, WireProfessor, WireTower, WireUnitBoard } from "@hmis/contracts";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { parsed } from "../../kernel/desk/http";
import { toHttp } from "./errors";
import { towerView } from "./tower";
import { nextCard, opdDeskView } from "./opd-desk";
import { nudge } from "./nudge";
import { listBriefs, markBriefSeen } from "./briefs";
import { unitOfOn } from "./scope";
import { unitBoard } from "./unit-board";
import { moveRow } from "./moves";
import { recordAct } from "./acts";
import { nowView, professorView } from "./phone";
import { logbookCsv, myRatings, rateWork } from "./ratings";
import { reportsFor } from "./report";
import { istDateOfInstant } from "../roster";
import type { Db } from "../../kernel/db/client";

/**
 * DD-0 (#626) — the Doctor Desk's four routes. The door is the doctor's existing `opd.consult` grant
 * (spec DECIDED 2: no new permission); every act re-checks the unit inside the domain call, and every
 * read is the asker's own (no user id in any path — the `/me` rule).
 */
const nudgeBody = z.object({ rowKey: z.string().min(3).max(120).regex(/^(alert|lab_critical|visit):[A-Za-z0-9_-]+$/) }).strict();
const rowKey = z.string().min(3).max(120).regex(/^(alert|lab_critical|visit):[A-Za-z0-9_-]+$/);
const moveBody = z.object({ rowKey, toUserId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }).strict();
const actBody = z.object({ rowKey, choice: z.enum(ACT_CHOICES), note: z.string().max(ACT_NOTE_MAX).nullable().optional() }).strict();
const rateBody = z.object({
  workKind: z.literal("opd_visit"), workId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  rating: z.enum(WORK_RATINGS), reason: z.string().max(RATING_REASON_MAX).nullable().optional(),
}).strict();
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

  /** DD-0.8 — the OPD desk page: my line, pace, the unit's colleagues in OPD, OPD-only "Waiting on you". */
  @Get("opd")
  @RequirePermission("opd.consult", "hospital")
  async opd(@CurrentActor() actor: Actor): Promise<WireOpdDesk> {
    try { return await opdDeskView(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-0.8 — the NEXT token card for one of MY visits (another doctor's visit is `unknown_visit`). */
  @Get("opd/next/:encounterId")
  @RequirePermission("opd.consult", "hospital")
  async next(@CurrentActor() actor: Actor, @Param("encounterId") encounterId: string): Promise<WireNextCard> {
    const id = parsed(briefId, encounterId);
    try { return await nextCard(this.db, actor, id, new Date()); } catch (e) { toHttp(e); }
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

  /* ═══ DD-1 (spec SPEC-doctor-desk-dd1-2026-10-16) — the unit board, move, act, the phones, ratings ═══ */

  /** DD-1.2 — the Unit board: owed full list oldest first, your people this week, units side by side (HOD/MS). */
  @Get("unit")
  @RequirePermission("opd.consult", "hospital")
  async unit(@CurrentActor() actor: Actor): Promise<WireUnitBoard> {
    try { return await unitBoard(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.2 — Move: the head or an SR gives an owed row to another member; audited, the source row untouched. */
  @Post("clocks/move")
  @HttpCode(200)
  @RequirePermission("opd.consult", "hospital")
  async move(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ moveId: string }> {
    const b = parsed(moveBody, body);
    try { return await moveRow(this.db, actor, b.rowKey, b.toUserId, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.3 — "What did you do?" on a lab critical; the act closes the loop (D3). */
  @Post("acts")
  @HttpCode(200)
  @RequirePermission("opd.consult", "hospital")
  async act(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ actId: string; minutes: number }> {
    const b = parsed(actBody, body);
    try { return await recordAct(this.db, actor, b.rowKey, b.choice, b.note ?? null, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.5 — the SR phone "Now": NOW criticals and TODAY rows (the roster strip is `/roster/my-duties`). */
  @Get("now")
  @RequirePermission("opd.consult", "hospital")
  async now(@CurrentActor() actor: Actor): Promise<WireNow> {
    try { return await nowView(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.4 — the Professor phone: owed, handled without you, work to rate (signatures are roster's and approvals' own routes). */
  @Get("professor")
  @RequirePermission("opd.consult", "hospital")
  async professor(@CurrentActor() actor: Actor): Promise<WireProfessor> {
    try { return await professorView(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.7 — a senior's word on a resident's finished work (PG logbook, never a league table). */
  @Post("ratings")
  @HttpCode(200)
  @RequirePermission("opd.consult", "hospital")
  async rate(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ ratingId: string }> {
    const b = parsed(rateBody, body);
    try { return await rateWork(this.db, actor, { workKind: b.workKind, workId: b.workId, rating: b.rating, reason: b.reason ?? null }, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.7 — my own ratings this month beside the department's and hospital's share; no names. */
  @Get("ratings/mine")
  @RequirePermission("opd.consult", "hospital")
  async mine(@CurrentActor() actor: Actor): Promise<WireMyRatings> {
    try { return await myRatings(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  /** DD-1.7 — my own PG logbook lines as CSV (no rater, no patient). */
  @Get("ratings/logbook.csv")
  @RequirePermission("opd.consult", "hospital")
  async logbook(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="pg-logbook.csv"');
    return logbookCsv(this.db, actor);
  }

  /** DD-report v0 — the 08:00 unit reports the asker may read (head: unit; HOD: department; MS: all), last 14 days. */
  @Get("reports")
  @RequirePermission("opd.consult", "hospital")
  async reports(@CurrentActor() actor: Actor): Promise<WireUnitReports> {
    try { return await reportsFor(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }
}
