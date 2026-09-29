import { Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { formFRegister, monthlyReturn } from "./pcpndt-books";
import { closeFormFGate } from "./usg-room";
import { idSchema, parsed, toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS7 T4 — the Ultrasound & PCPNDT station's two books (read-only) and the room's one gate door.
 *
 *   · `GET /radiology/pcpndt/register?month=YYYY-MM` — the Form F serials of the month, BY SERIAL and
 *     with no patient field (`pcpndt-books.ts` says why), and the year's gap check per machine. Behind
 *     `pcpndt.form_f.read`: the people who already read a Form F by study (sonologist, technologist,
 *     in-charge) — this list names none of the women those forms are about.
 *   · `GET /radiology/pcpndt/monthly-return?month=YYYY-MM` — counts per machine, the discrepancies
 *     to close, the due date (the 5th) and a CSV. Behind `pcpndt.registrations.read`: the in-charge
 *     and the radiologist, who hold the register of premises, machines and people it is built on.
 *
 *   · `POST /radiology/pcpndt/studies/:studyId/form-f-gate` — the sonologist closes the `form_f`
 *     gate from the register row she wrote (`usg-room.ts` says why this one kind has its own door).
 *
 * Submission is a human act on the state portal; nothing here claims it was sent.
 */
@Controller("radiology/pcpndt")
export class RadiologyPcpndtController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("register")
  @RequirePermission("pcpndt.form_f.read", "hospital")
  async register(@Query("month") month?: string): Promise<unknown> {
    try {
      return await formFRegister(this.db, { month: month === "" ? undefined : month });
    } catch (e) { toHttp(e); }
  }

  @Get("monthly-return")
  @RequirePermission("pcpndt.registrations.read", "hospital")
  async monthly(@Query("month") month?: string): Promise<unknown> {
    try {
      return await monthlyReturn(this.db, { month: month === "" ? undefined : month });
    } catch (e) { toHttp(e); }
  }

  @Post("studies/:studyId/form-f-gate")
  @RequirePermission("pcpndt.form_f.write", "hospital")
  async formFGate(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => closeFormFGate(tx, actor, parsed(idSchema, studyId)));
    } catch (e) { toHttp(e); }
  }
}
