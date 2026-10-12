import { Logger } from "@nestjs/common";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { BMW_LIMIT_HOURS, BMW_ON_SITE_STATES, BMW_WARN_HOURS, bmwClockLevel } from "@hmis/contracts";
import { raiseNotice } from "../../kernel/alerts/notices";
import { bmwBags, resources } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { BMW_SUPERVISOR_ROLE } from "./kinds";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE STORAGE CLOCK — `sweepBmwStorage`, ON THE TASK CLOCK'S MINUTE ═══
 *
 * BMW Rules 2016 r.8(3): untreated waste is not stored beyond 48 hours. The clock runs per bag FROM GENERATION
 * (DECIDED: the stricter, standard reading — the Rules count the time untreated, not the time in the store)
 * for every bag still on the premises (`generated`, `collected`, `stored`). At 36 hours it WARNS, at 48 it
 * ALERTS, each holder of the BMW supervisor role (`services_supervisor`) through the bell.
 *
 * One notice per level per GENERATION HOUR, not per bag: a missed pickup leaves dozens of bags crossing the
 * line in the same hour, and one bell saying "12 bags" is read where twelve are muted. The source key is the
 * hour and the level, so a second tick, a second worker or a restart raises nothing twice.
 *
 * It rides the `sweepTasks` job (`kernel/worker/jobs.ts`) rather than holding a pool client of its own;
 * `now` is the tick's.
 */
export const BMW_CLOCK_BATCH = 500;
/** Nobody holds the BMW supervisor role (a new site, a vacancy): the administration is told instead. */
export const BMW_FALLBACK_ROLE = "admin";
const log = new Logger("bmw.clock");

/** `unnotified` counts the breaching BAGS that reached no one: no supervisor and no admin to tell. */
export type BmwClockResult = { warning: number; alert: number; noticesRaised: number; unnotified: number };

export async function sweepBmwStorage(db: Db, now: Date = new Date()): Promise<BmwClockResult> {
  const warnBefore = new Date(now.getTime() - BMW_WARN_HOURS * 3_600_000);
  const rows = await db.select({
    id: bmwBags.id, barcode: bmwBags.barcode, generatedAt: bmwBags.generatedAt, placeName: resources.name,
  }).from(bmwBags).innerJoin(resources, eq(resources.id, bmwBags.placeResourceId))
    .where(and(inArray(bmwBags.state, [...BMW_ON_SITE_STATES]), lte(bmwBags.generatedAt, warnBefore)))
    .orderBy(asc(bmwBags.generatedAt)).limit(BMW_CLOCK_BATCH);
  const out: BmwClockResult = { warning: 0, alert: 0, noticesRaised: 0, unnotified: 0 };
  if (rows.length === 0) return out;

  type Bucket = { level: "warning" | "alert"; hour: string; bags: number; places: Set<string>; oldest: Date };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const level = bmwClockLevel(r.generatedAt, now);
    if (level === "ok") continue;
    out[level] += 1;
    const hour = new Date(Math.floor(r.generatedAt.getTime() / 3_600_000) * 3_600_000).toISOString();
    const key = `${level}:${hour}`;
    const b = buckets.get(key) ?? { level, hour, bags: 0, places: new Set<string>(), oldest: r.generatedAt };
    b.bags += 1;
    b.places.add(r.placeName);
    if (r.generatedAt < b.oldest) b.oldest = r.generatedAt;
    buckets.set(key, b);
  }
  let holders = await db.transaction((t) => usersHoldingRole(t, BMW_SUPERVISOR_ROLE));
  if (holders.length === 0) holders = await db.transaction((t) => usersHoldingRole(t, BMW_FALLBACK_ROLE));
  if (holders.length === 0 && buckets.size > 0) {
    out.unnotified = out.warning + out.alert;
    log.error(`bio-medical waste storage clock: ${String(out.alert)} bags over ${String(BMW_LIMIT_HOURS)} h and ${String(out.warning)} over ${String(BMW_WARN_HOURS)} h, and NOBODY holds ${BMW_SUPERVISOR_ROLE} or ${BMW_FALLBACK_ROLE} to tell`);
    return out;
  }
  for (const b of buckets.values()) {
    const hours = Math.floor((now.getTime() - b.oldest.getTime()) / 3_600_000);
    const title = b.level === "alert" ? `Waste over ${String(BMW_LIMIT_HOURS)} h · ${String(b.bags)} bags` : `Waste ${String(hours)} h · ${String(b.bags)} bags`;
    const places = [...b.places].sort();
    const body = places.slice(0, 3).join(", ") + (places.length > 3 ? ` +${String(places.length - 3)}` : "");
    for (const userId of holders) {
      const raised = await raiseNotice(db, {
        userId, kind: b.level === "alert" ? "bmw.storage_alert" : "bmw.storage_warning", title, body,
        refType: "bmw_storage", refId: b.hour, sourceKey: `bmw:storage:${b.level}:${b.hour}`, at: now,
      });
      if (raised) out.noticesRaised += 1;
    }
  }
  return out;
}
