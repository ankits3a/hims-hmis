import { Controller, Get, Inject, Query } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { istDayString } from "../../kernel/approvals/cumulative";
import { escalationList } from "./escalations";
import {
  supervisorAccessLog, supervisorApprovals, supervisorEquipment, supervisorFloor, supervisorMoney, supervisorQuality,
  supervisorRoster,
} from "./supervisor";
import { toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS10 — **THE SUPERVISOR & HOD's READS, OVER HTTP.** Eight GETs, one grant.
 *
 * ═══ THE GRANT IS `radiology.definitions.manage` — DECIDED, NO NEW PERMISSION ═══
 *
 * The HOD is a radiologist, and the one radiology grant that is the department HEAD's rather than
 * every reader's is the books: `radiology.definitions.manage` (the department's study types, gate
 * sets, critical categories, signatories — drafted by the HOD, approved by the MS) is held by
 * `radiologist` alone. `radiology.reports.sign` (RS9's north star) was the other candidate and is
 * held by the resident too (RS8b), who is not a supervisor; the access log in particular is a head's
 * read. Minting `radiology.supervise` would have been a permission with exactly the same holder.
 *
 * Nothing here writes, except the access log's own PHI rows (one per patient it names). The HOD's
 * ACTS go through the seats' own routes and the kernel's (`/alerts/:id/ack`, the override decide
 * route, `/approvals`), so no act has two doors.
 */
@Controller("radiology/supervisor")
export class RadiologySupervisorController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("floor")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async floor(): Promise<unknown> {
    try { return await supervisorFloor(this.db, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("escalations")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async escalations(@CurrentActor() actor: Actor): Promise<unknown> {
    try { return await escalationList(this.db, actor, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("approvals")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async approvals(): Promise<unknown> {
    try { return await supervisorApprovals(this.db, new Date()); } catch (e) { toHttp(e); }
  }

  /** `?from&to` — IST days, inclusive; default the last seven. */
  @Get("quality")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async quality(@Query("from") from?: string, @Query("to") to?: string): Promise<unknown> {
    try {
      const now = new Date();
      const today = istDayString(now);
      return await supervisorQuality(this.db, {
        from: from ?? istDayString(new Date(now.getTime() - 6 * 86_400_000)), to: to ?? today, now,
      });
    } catch (e) { toHttp(e); }
  }

  @Get("equipment")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async equipment(): Promise<unknown> {
    try { return await supervisorEquipment(this.db, new Date()); } catch (e) { toHttp(e); }
  }

  @Get("roster")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async roster(): Promise<unknown> {
    try { return await supervisorRoster(this.db, new Date()); } catch (e) { toHttp(e); }
  }

  /** `?day` — the IST day billed; default today. Month to date runs to that day. */
  @Get("money")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async money(@Query("day") day?: string): Promise<unknown> {
    try { return await supervisorMoney(this.db, { ...(day ? { day } : {}), now: new Date() }); } catch (e) { toHttp(e); }
  }

  /** `?from&to` — IST days, inclusive, at most 31; default today. Names patients: PHI-logged. */
  @Get("access-log")
  @RequirePermission("radiology.definitions.manage", "hospital")
  async accessLog(@CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string): Promise<unknown> {
    try {
      const today = istDayString(new Date());
      return await supervisorAccessLog(this.db, actor, { from: from ?? today, to: to ?? today });
    } catch (e) { toHttp(e); }
  }
}
