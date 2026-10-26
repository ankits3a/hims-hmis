import { and, eq, gte, sql } from "drizzle-orm";
import { HK_DOOR_PER_AREA_HOUR, HOUSEKEEPING_KINDS, doorRequestInput, newId } from "@hmis/contracts";
import { hmacSign } from "../../kernel/crypto";
import { withTx } from "../../kernel/db/client";
import { hkDoorRequests } from "../../kernel/db/schema";
import { getTask, raiseTask } from "../tasks";
import { HousekeepingRefusal } from "./errors";
import { HOUSEKEEPING_DOOR_ACTOR } from "./names";
import { parse, readQrToken } from "./setup";
import type { HkDoorAck, HkDoorNeed } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * HK-1 (#973) — A REQUEST FROM THE DOOR QR, WITH NO LOGIN. Anyone at the place (a patient, an attendant, a visitor) picks
 * one of four needs; nothing about them is asked or kept — the caller's address only as a keyed hash, for the per-address
 * throttle the door applies. The task goes to the team placed on that place (the rota's eligibility), like any other.
 * A door cannot flood the floor: `HK_DOOR_PER_AREA_HOUR` requests an hour per area, counted in the database under a lock.
 * Closed = its task is done (the attendant still scans and answers, like any task at an area).
 */
const NEED_NOTE: Readonly<Record<HkDoorNeed, string>> = { clean: "Clean", toilet: "Toilet", spill: "Spill", bin: "Bin" };

export async function raiseDoorRequest(
  db: Db, key: Buffer, raw: unknown, meta: { address: string }, now: Date = new Date(),
): Promise<HkDoorAck> {
  const input = parse(doorRequestInput, raw);
  const area = await readQrToken(db, key, input.token);
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hk:door:${area.id}`}))`);
    const recent = await tx.select({ n: sql<number>`count(*)::int` }).from(hkDoorRequests)
      .where(and(eq(hkDoorRequests.areaId, area.id), gte(hkDoorRequests.createdAt, new Date(now.getTime() - 3_600_000))));
    if ((recent[0]?.n ?? 0) >= HK_DOOR_PER_AREA_HOUR) throw new HousekeepingRefusal("too_many_requests", { areaId: area.id });
    const requestId = newId();
    const { task } = await raiseTask(tx, HOUSEKEEPING_DOOR_ACTOR, {
      kind: input.need === "spill" ? HOUSEKEEPING_KINDS.spill : HOUSEKEEPING_KINDS.request,
      placeResourceId: area.resourceId, note: `Door QR: ${NEED_NOTE[input.need]}`, source: "device",
      priority: input.need === "spill" ? "urgent" : "routine", sourceRef: `hk-door:${requestId}`,
    }, now);
    await tx.insert(hkDoorRequests).values({
      id: requestId, areaId: area.id, need: input.need, taskId: task.id,
      addressHash: hmacSign(key, `hmis.hk.door.address.v1|${meta.address}`), createdAt: now,
    });
    return { requestId, taskId: task.id };
  });
}

export async function doorRequestOf(db: Db, requestId: string): Promise<{ id: string; areaId: string; need: HkDoorNeed; taskId: string; closed: boolean } | null> {
  const r = (await db.select().from(hkDoorRequests).where(eq(hkDoorRequests.id, requestId)))[0];
  if (r === undefined) return null;
  const task = await getTask(db, r.taskId);
  return { id: r.id, areaId: r.areaId, need: r.need as HkDoorNeed, taskId: r.taskId, closed: task !== null && ["done", "verified", "cancelled"].includes(task.state) };
}
