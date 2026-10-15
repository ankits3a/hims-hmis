import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UseGuards, applyDecorators } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { eq } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { labBookingSettings } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { DB } from "../../kernel/tokens";
import { LAB_BOOKING_RULES } from "./bookings";
import { LabError } from "./errors";
import { toHttp } from "./lab-http";
import { labModeChanged } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * OWNER 2026-10-12 — "Let admin disable/enable the Quick Lab mode menu. If enabled, only quick lab
 * menu should show up. If disabled, only full lab mode menu should show up."
 *
 * ONE hospital-wide setting, on the lab's settings row (default `quick`, the lab's everyday path since
 * decision 0068). Changed by the lab's administrator (`lab.catalogue.manage`, as the booking hours),
 * and every change is a `lab.mode_changed` event naming who and when.
 *
 * The web hides the other mode's menus; THIS file makes the server agree: the other mode's WORK
 * routes (queues, entry, collection, verification, hand-over) answer `lab_mode_off`. Reading a report
 * that already exists — the profile, the doctor, a reprint, the report centre's reads — is never
 * mode-gated, so switching never hides an old report.
 */
export type LabMode = "quick" | "full";
export const LAB_MODES: readonly LabMode[] = ["quick", "full"];

export async function labMode(exec: Db | Tx): Promise<LabMode> {
  const [row] = await (exec as Db).select({ mode: labBookingSettings.labMode }).from(labBookingSettings)
    .where(eq(labBookingSettings.id, "main"));
  return row?.mode === "full" ? "full" : "quick";
}

export async function setLabMode(tx: Tx, actor: Actor, mode: LabMode, now: Date = new Date()): Promise<LabMode> {
  if (actor.type !== "user" || !(await hasPermission(tx, actor.id, "lab.catalogue.manage", "hospital"))) {
    throw new LabError("permission_denied", "the lab mode is set by the lab's administrator (lab.catalogue.manage)");
  }
  if (!LAB_MODES.includes(mode)) throw new LabError("catalogue_invalid", `lab mode is quick or full, not ${String(mode)}`);
  const from = await labMode(tx);
  if (from === mode) return mode;
  const r = LAB_BOOKING_RULES;
  await tx.insert(labBookingSettings).values({
    id: "main", openAt: r.open, closeAt: r.close, slotMinutes: r.slotMinutes, perSlot: r.perSlot, daysAhead: r.daysAhead,
    closedWeekdays: [...r.closedWeekdays], labMode: mode, updatedBy: actor.id, updatedAt: now,
  }).onConflictDoUpdate({ target: labBookingSettings.id, set: { labMode: mode, updatedBy: actor.id, updatedAt: now } });
  await appendEvent(tx, labModeChanged.make({ actor, occurredAt: now, payload: { from, to: mode } }));
  return mode;
}

const LAB_MODE_KEY = "hmis:lab-mode";

/**
 * Runs AFTER the global identity and permission guards (a controller guard always does), so an
 * unauthenticated or unpermitted caller is refused exactly as before and only a permitted one learns
 * the mode is off.
 */
@Injectable()
export class LabModeGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const wanted = this.reflector.getAllAndOverride<LabMode | undefined>(LAB_MODE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (wanted === undefined) return true;
    const now = await labMode(this.db);
    if (now !== wanted) {
      try {
        throw new LabError("lab_mode_off", now === "quick"
          ? "Full lab mode is off — the lab runs in quick mode (Lab counter, Quick Collect, Quick Bench, Quick Reports)"
          : "Quick lab mode is off — the lab runs in full mode (desk, collection, bench, verify, report centre)", { mode: now });
      } catch (e) { toHttp(e); }
    }
    return true;
  }
}

/** This route belongs to one mode's work and refuses while the lab runs the other. */
export const LabModeOnly = (mode: LabMode): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(LAB_MODE_KEY, mode), UseGuards(LabModeGuard));
