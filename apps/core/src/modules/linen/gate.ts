import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { linenBedWaits, linenItems, resources } from "../../kernel/db/schema";
import { isModuleOn } from "../../kernel/modules/switch";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { markBedCleanIn, plannedDischargeBeds } from "../ipd";
import { theatreCasesOn } from "../ot";
import { wardOfBed } from "./holds";
import { lock } from "./intents";
import { bookBalances, wardShapes } from "./reads";
import type { Actor, LinenBedWait, LinenRushDemand } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { Exec } from "./intents";

/**
 * ═══ THE BED-READY LINK (LD-1, #978, D3) ═══ — a bed is ready only when it is cleaned AND made. Housekeeping's passed
 * check asks `bedReadyGate` before it frees the bed. The bed is made from the ward's SHELF: on hand by the book, less
 * one set on each occupied bed, less one set for each bed already waiting. Short of one set → the bed stays in cleaning
 * with a wait row ("waiting for linen") and the wait is a rush top-up for the linen room. The top-up that fills the shelf
 * clears the waits in the order they were raised and frees those beds (`releaseLinenWaits`, called by `topUpWard`).
 *
 * While `linen` is dark (decision 0085) the gate lets every bed through.
 * DECIDED: a ward that has never been counted and has never moved linen is not live on linen, and the gate lets its beds
 * through — the gate never blocks a hospital that has not started using the module. A bed marked clean by hand at the
 * Beds board is the duty manager's call and is not gated.
 */

/** Pieces of each item in one bed set (items in a ward bed's set only). */
async function setShape(t: Exec): Promise<Map<string, number>> {
  const rows = await t.select({ code: linenItems.code, units: linenItems.unitsPerSet }).from(linenItems)
    .where(and(eq(linenItems.active, true), sql`${linenItems.unitsPerSet} > 0`));
  return new Map(rows.map((r) => [r.code, r.units]));
}

async function wardIsLive(t: Exec, wardId: string): Promise<boolean> {
  const r = await t.execute<{ live: boolean }>(sql`
    select exists (select 1 from linen_ward_counts where ward_resource_id = ${wardId})
        or exists (select 1 from linen_movements where ward_resource_id = ${wardId} or to_ward_resource_id = ${wardId}) as live`);
  return r.rows[0]?.live === true;
}

async function occupiedBeds(t: Exec, wardId: string): Promise<number> {
  const r = await t.execute<{ n: string }>(sql`
    with recursive under as (
      select id, kind, status, 1 as depth from resources where parent_id = ${wardId}
      union all
      select r.id, r.kind, r.status, u.depth + 1 from resources r join under u on r.parent_id = u.id
       where u.kind <> 'ward' and u.depth < 8
    ) select count(*) as n from under where kind = 'bed' and status = 'occupied'`);
  return Number(r.rows[0]?.n ?? 0);
}

/** What one more set would lack on the ward's shelf, given `waiting` beds ahead of it: { itemCode: pieces }. */
export async function shelfShort(t: Exec, wardId: string, now: Date, waiting: number): Promise<Record<string, number>> {
  const set = await setShape(t);
  const book = (await bookBalances(t, now, wardId)).get(wardId);
  const reserved = (await occupiedBeds(t, wardId)) + waiting;
  const short: Record<string, number> = {};
  for (const [code, units] of set) {
    const shelf = (book?.get(code)?.onHand ?? 0) - reserved * units;
    if (shelf < units) short[code] = units - Math.max(0, shelf);
  }
  return short;
}

/**
 * Asked by housekeeping inside the check's transaction. → `ready: true` to free the bed now; otherwise the bed waits for
 * linen (a wait row, rush) and stays in cleaning.
 */
export async function bedReadyGate(t: Tx, actor: Actor, bedId: string, now: Date): Promise<{ ready: boolean; short: Record<string, number> }> {
  if (!isModuleOn("linen")) return { ready: true, short: {} };
  const bed = await wardOfBed(t, bedId);
  if (bed === null || !(await wardIsLive(t, bed.wardId))) return { ready: true, short: {} };
  await lock(t, `ward:${bed.wardId}`);
  const waiting = await t.select({ bed: linenBedWaits.bedResourceId }).from(linenBedWaits)
    .where(and(eq(linenBedWaits.wardResourceId, bed.wardId), isNull(linenBedWaits.clearedAt)));
  const ahead = waiting.filter((w) => w.bed !== bedId).length;
  const short = await shelfShort(t, bed.wardId, now, ahead);
  if (Object.keys(short).length === 0) return { ready: true, short };
  await t.insert(linenBedWaits).values({
    id: newId(), bedResourceId: bedId, wardResourceId: bed.wardId, short, rush: true, raisedAt: now, raisedBy: actor.id,
  }).onConflictDoNothing();
  return { ready: false, short };
}

/**
 * After linen reached a ward (a top-up): clear its waits oldest first while the shelf holds a set for each, and free
 * those beds still in cleaning. Call under the ward's lock, after the movement is written. → beds freed.
 */
export async function releaseLinenWaits(t: Tx, actor: Actor, wardId: string, now: Date): Promise<number> {
  const waits = await t.select().from(linenBedWaits)
    .where(and(eq(linenBedWaits.wardResourceId, wardId), isNull(linenBedWaits.clearedAt))).orderBy(asc(linenBedWaits.raisedAt), asc(linenBedWaits.id));
  let freed = 0;
  for (const [i, w] of waits.entries()) {
    // The beds cleared before this one in this act now hold their sets; the ones after it are not counted yet.
    if (Object.keys(await shelfShort(t, wardId, now, i)).length > 0) break;
    await t.update(linenBedWaits).set({ clearedAt: now, clearedBy: actor.id }).where(eq(linenBedWaits.id, w.id));
    const status = (await t.select({ status: resources.status }).from(resources).where(eq(resources.id, w.bedResourceId)))[0]?.status;
    if (status === "cleaning") await markBedCleanIn(t, actor, w.bedResourceId, now);
    freed += 1;
  }
  return freed;
}

/** Beds clean but not made, oldest first (the Beds board's and the linen room's "waiting for linen"). */
export async function bedsWaitingForLinen(exec: Exec): Promise<LinenBedWait[]> {
  const rows = await exec.select({ w: linenBedWaits, bedName: resources.name }).from(linenBedWaits)
    .innerJoin(resources, eq(resources.id, linenBedWaits.bedResourceId))
    .where(isNull(linenBedWaits.clearedAt)).orderBy(asc(linenBedWaits.raisedAt));
  return rows.map(({ w, bedName }) => ({
    bedId: w.bedResourceId, bedName, wardId: w.wardResourceId, short: w.short, rush: w.rush, raisedAt: w.raisedAt.toISOString(),
  }));
}

/**
 * The day's rush demand: each ward's beds with a discharge planned today (IST) will each need a set, and the shelf's
 * shortfall for that many sets, beyond the beds already waiting; plus the number of theatre cases on today's lists. The
 * linen room acts on it at 09:00 (DECIDED: computed on read, so the board shows the morning's demand as it stands).
 */
export async function rushDemand(exec: Exec, now: Date): Promise<LinenRushDemand> {
  const { start, end } = istDayWindow(now);
  const beds = await plannedDischargeBeds(exec, start, end);
  const byWard = new Map<string, number>();
  for (const bedId of beds) {
    const w = await wardOfBed(exec, bedId);
    if (w !== null) byWard.set(w.wardId, (byWard.get(w.wardId) ?? 0) + 1);
  }
  const wards = [];
  for (const [wardId, discharges] of byWard) {
    const shape = (await wardShapes(exec, wardId))[0];
    const waiting = (await exec.select({ id: linenBedWaits.id }).from(linenBedWaits)
      .where(and(eq(linenBedWaits.wardResourceId, wardId), isNull(linenBedWaits.clearedAt)))).length;
    wards.push({ wardId, wardName: shape?.wardName ?? wardId, discharges, short: await shelfShort(exec, wardId, now, waiting + discharges - 1) });
  }
  wards.sort((a, b) => a.wardName.localeCompare(b.wardName));
  return { day: istDayString(now), wards, theatreCases: await theatreCasesOn(exec, istDayString(now)) };
}
