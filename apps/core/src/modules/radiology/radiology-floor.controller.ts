import { Controller, Get, Inject } from "@nestjs/common";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { istDayString } from "../../kernel/approvals/cumulative";
import { imagingDevices } from "./devices";
import { portableRound } from "./bedside";
import { toHttp } from "./radiology-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS2b — **THE MACHINES AND THE PORTABLE ROUND, OVER HTTP.** Two reads.
 *
 * ═══ `GET /radiology/devices` IS BEHIND `radiology.worklist.read` — DECIDED ═══
 *
 * The house has no either-of grant (`RequirePermission` takes one key), and the brief allowed
 * `radiology.schedule` OR `radiology.worklist.read`. The one permission the receptionist (who
 * books) AND the technologist (who runs the machine) both hold is `radiology.worklist.read` —
 * the radiologist holds it too, which is harmless: the list names machines, not patients.
 *
 * `GET /radiology/portable/round` is behind `radiology.acquire`, the technologist's permission:
 * the round is the list of beds the trolley goes to, and it names patients.
 */
@Controller("radiology")
export class RadiologyFloorController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("devices")
  @RequirePermission("radiology.worklist.read", "hospital")
  async devices(): Promise<unknown> {
    try {
      return { devices: await imagingDevices(this.db, istDayString(new Date())) };
    } catch (e) { toHttp(e); }
  }

  @Get("portable/round")
  @RequirePermission("radiology.acquire", "hospital")
  async round(@CurrentActor() actor: Actor): Promise<unknown> {
    try {
      return { rows: await portableRound(this.db, actor) };
    } catch (e) { toHttp(e); }
  }
}
