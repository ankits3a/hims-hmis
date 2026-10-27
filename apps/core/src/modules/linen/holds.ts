import { and, eq, inArray, lte } from "drizzle-orm";
import { LINEN_CHEMO_HOLD_HOURS, newId, placeHoldInput, releaseHoldInput } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { linenBags, linenHolds, linenMovements, resources } from "../../kernel/db/schema";
import { MAX_RESOURCE_DEPTH } from "../../kernel/resources";
import { appointedPerson } from "../aerb";
import { LinenError } from "./errors";
import { lock, movement, parse, stamp, tx } from "./intents";
import type { Actor, LinenHoldCard, LinenHoldKind } from "@hmis/contracts";
import type { Exec } from "./intents";
import type { Tx } from "../../kernel/db/client";

/**
 * ═══ HOLDS (LD-1, #978, D4) ═══ — linen blocked from the laundry. It is bagged at its bed, and every bag from that bed
 * stays out of a pickup and out of a batch while a hold on the bed is active. Each kind has its own owner:
 *   · MLC — evidence. Released only by recording the police receiver (name, rank, station); the bags go to the police,
 *     off the ward's book (`hold_handed_over`), never to the laundry.
 *   · chemotherapy — released by the clock, 48 hours after the dose (`runLinenClock`); no hand releases it.
 *   · radioactive iodine — released only by the RSO appointed today (aerb).
 * A hold names a bed and its ward, never the patient.
 */
export type HoldRow = typeof linenHolds.$inferSelect;
export const LINEN_CLOCK_ID = "linen-clock";

/** The ward a bed sits under (bed → room → ward), or null when it is not under a ward. */
export async function wardOfBed(exec: Exec, bedId: string): Promise<{ bedId: string; bedName: string; wardId: string } | null> {
  const bed = (await exec.select().from(resources).where(eq(resources.id, bedId)))[0];
  if (bed === undefined || bed.kind !== "bed") return null;
  let parentId = bed.parentId;
  for (let level = 1; level < MAX_RESOURCE_DEPTH && parentId !== null; level += 1) {
    const p = (await exec.select({ id: resources.id, kind: resources.kind, parentId: resources.parentId }).from(resources)
      .where(eq(resources.id, parentId)))[0];
    if (p === undefined) return null;
    if (p.kind === "ward") return { bedId: bed.id, bedName: bed.name, wardId: p.id };
    parentId = p.parentId;
  }
  return null;
}

/** Refuse a bag whose bed is under an active hold (`on_hold`). */
export async function requireNotHeld(t: Exec, bag: { tag: string; bedResourceId: string | null }): Promise<void> {
  if (bag.bedResourceId === null) return;
  const hold = (await t.select({ id: linenHolds.id, kind: linenHolds.kind }).from(linenHolds)
    .where(and(eq(linenHolds.bedResourceId, bag.bedResourceId), eq(linenHolds.state, "active"))).limit(1))[0];
  if (hold !== undefined) throw new LinenError("on_hold", { tag: bag.tag, holdId: hold.id, kind: hold.kind });
}

export async function placeHold(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<HoldRow> {
  const input = parse(placeHoldInput, raw);
  return tx(exec, async (t) => {
    const bed = await wardOfBed(t, input.bedId);
    if (bed === null) throw new LinenError("unknown_bed", { bedId: input.bedId });
    await lock(t, `ward:${bed.wardId}`);
    const now = await stamp(t, nowIn);
    const releaseAfter = input.doseAt === undefined ? null : new Date(Date.parse(input.doseAt) + LINEN_CHEMO_HOLD_HOURS * 3_600_000);
    return (await t.insert(linenHolds).values({
      id: newId(), kind: input.kind, bedResourceId: bed.bedId, wardResourceId: bed.wardId, note: input.note ?? null,
      releaseAfter, state: "active", placedBy: actor.id, placedAt: now,
    }).returning())[0]!;
  });
}

/**
 * Release a hold by its owner. MLC: the police receiver is recorded and the bed's sealed bags are handed over (off the
 * ward's book). Chemotherapy: refused — the clock releases it. Radioactive: only the RSO appointed today.
 */
export async function releaseHold(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<HoldRow> {
  const input = parse(releaseHoldInput, raw);
  return tx(exec, async (t) => {
    const hold = (await t.select().from(linenHolds).where(eq(linenHolds.id, input.holdId)).for("update"))[0];
    if (hold === undefined) throw new LinenError("unknown_hold", { holdId: input.holdId });
    if (hold.state !== "active") throw new LinenError("hold_closed", { holdId: hold.id, state: hold.state });
    await lock(t, `ward:${hold.wardResourceId}`);
    const now = await stamp(t, nowIn);
    const kind = hold.kind as LinenHoldKind;
    if (kind === "chemo") throw new LinenError("released_by_clock", { holdId: hold.id, releaseAfter: hold.releaseAfter?.toISOString() });
    if (kind === "radioactive") {
      const rso = await appointedPerson(t, "rso", istDayString(now));
      if (rso === null || rso.userId !== actor.id) throw new LinenError("not_rso", { holdId: hold.id });
      return (await t.update(linenHolds).set({ state: "released", releasedBy: actor.id, releasedAt: now })
        .where(eq(linenHolds.id, hold.id)).returning())[0]!;
    }
    if (input.police === undefined) throw new LinenError("police_receiver_missing", { holdId: hold.id });
    await handOverBags(t, actor, hold, now);
    return (await t.update(linenHolds).set({
      state: "handed_over", releasedBy: actor.id, releasedAt: now,
      policeName: input.police.name, policeRank: input.police.rank, policeStation: input.police.station,
    }).where(eq(linenHolds.id, hold.id)).returning())[0]!;
  });
}

/** The bed's sealed bags leave the ward's book to the police: one `hold_handed_over` row per declared line. */
async function handOverBags(t: Tx, actor: Actor, hold: HoldRow, now: Date): Promise<void> {
  const bags = await t.select().from(linenBags)
    .where(and(eq(linenBags.bedResourceId, hold.bedResourceId), eq(linenBags.state, "sealed")));
  if (bags.length === 0) return;
  await t.insert(linenMovements).values(bags.flatMap((b) => b.lines.map((l) => movement("hold_handed_over", l, actor, now, {
    wardResourceId: b.wardResourceId, bagId: b.id,
  }))));
  await t.update(linenBags).set({ state: "handed_over" }).where(inArray(linenBags.id, bags.map((b) => b.id)));
}

/** The clock's half: every chemotherapy hold whose 48 hours are over is released. → how many. */
export async function releaseExpiredHolds(exec: Exec, now: Date): Promise<number> {
  const rows = await exec.update(linenHolds).set({ state: "released", releasedBy: LINEN_CLOCK_ID, releasedAt: now })
    .where(and(eq(linenHolds.kind, "chemo"), eq(linenHolds.state, "active"), lte(linenHolds.releaseAfter, now)))
    .returning({ id: linenHolds.id });
  return rows.length;
}

/** Active holds, oldest first, with the bed's name (never the patient's). */
export async function activeHolds(exec: Exec): Promise<LinenHoldCard[]> {
  const rows = await exec.select({ h: linenHolds, bedName: resources.name }).from(linenHolds)
    .innerJoin(resources, eq(resources.id, linenHolds.bedResourceId))
    .where(eq(linenHolds.state, "active")).orderBy(linenHolds.placedAt);
  return rows.map(({ h, bedName }) => ({
    id: h.id, kind: h.kind as LinenHoldKind, bedId: h.bedResourceId, bedName, wardId: h.wardResourceId,
    state: h.state as LinenHoldCard["state"], placedAt: h.placedAt.toISOString(), releaseAfter: h.releaseAfter?.toISOString() ?? null,
  }));
}
