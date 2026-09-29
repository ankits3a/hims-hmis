import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import {
  irCaseList, irCaseView, irHandoffSchema, irNoteSchema, irSignInSchema, irSignOutSchema, irSkinFollowUpSchema,
  irTimeOutSchema, irVitalsSchema, overrideCoagulation, recordHandoff, recordProcedureNote, recordSedationVitals,
  recordSkinFollowUp, irSignIn, irSignOut, irTimeOut,
} from "./ir";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS12b — **THE IR SUITE, OVER HTTP.** Everything is the technologist's and the
 * radiologist's `radiology.acquire` — the same permission as the room console, because this IS a
 * room console for a procedure — except the coagulation override, which is the radiologist's
 * `radiology.gates.override` (the nurse and the technologist ask; the operator decides, in writing).
 *
 *   · `GET  /radiology/ir/cases` — the suite's one list;
 *   · `GET  /radiology/studies/:id/ir` — the case in hand;
 *   · `POST …/ir/sign-in | time-out | sign-out` — the WHO phases, once each;
 *   · `POST …/ir/coagulation-override {reason}`;
 *   · `POST …/ir/vitals` — a sedation-chart reading;
 *   · `POST …/ir/skin-follow-up` — Ka,r ≥ 3 Gy: patient told, skin check booked;
 *   · `POST …/ir/note` — the procedure note; `POST …/ir/handoff` — to recovery.
 */
const overrideBody = z.object({ reason: z.string().trim().min(5).max(600) }).strict();

@Controller("radiology")
export class RadiologyIrController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("ir/cases")
  @RequirePermission("radiology.acquire", "hospital")
  async cases(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await irCaseList(this.db, actor) };
    } catch (e) { toHttp(e); }
  }

  @Get("studies/:studyId/ir")
  @RequirePermission("radiology.acquire", "hospital")
  async view(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    parsed(idSchema, studyId);
    try {
      return { case: await irCaseView(this.db, actor, studyId) };
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/sign-in")
  @RequirePermission("radiology.acquire", "hospital")
  async signIn(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irSignInSchema, body);
    try {
      return await withTx(this.db, (tx) => irSignIn(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/time-out")
  @RequirePermission("radiology.acquire", "hospital")
  async timeOut(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irTimeOutSchema, body);
    try {
      return await withTx(this.db, (tx) => irTimeOut(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/sign-out")
  @RequirePermission("radiology.acquire", "hospital")
  async signOut(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irSignOutSchema, body);
    try {
      return await withTx(this.db, (tx) => irSignOut(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/coagulation-override")
  @RequirePermission("radiology.gates.override", "hospital")
  async coagOverride(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(overrideBody, body);
    try {
      return await withTx(this.db, (tx) => overrideCoagulation(tx, actor, studyId, input.reason));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/vitals")
  @RequirePermission("radiology.acquire", "hospital")
  async vitals(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irVitalsSchema, body);
    try {
      return await withTx(this.db, (tx) => recordSedationVitals(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/skin-follow-up")
  @RequirePermission("radiology.acquire", "hospital")
  async skin(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irSkinFollowUpSchema, body);
    try {
      return await withTx(this.db, (tx) => recordSkinFollowUp(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/note")
  @RequirePermission("radiology.acquire", "hospital")
  async note(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irNoteSchema, body);
    try {
      return await withTx(this.db, (tx) => recordProcedureNote(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/ir/handoff")
  @RequirePermission("radiology.acquire", "hospital")
  async handoff(@CurrentActor() actor: Actor, @Param("studyId") studyId: string, @Body() body: unknown): Promise<unknown> {
    parsed(idSchema, studyId);
    const input = parsed(irHandoffSchema, body);
    try {
      return await withTx(this.db, (tx) => recordHandoff(tx, actor, studyId, input));
    } catch (e) { toHttp(e); }
  }
}
