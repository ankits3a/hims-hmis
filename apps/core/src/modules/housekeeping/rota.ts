import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { HK_IN_HOUSE, HOUSEKEEPING_KINDS, hkShiftAt, newId, publishRotaInput, saveRotaInput } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { hkAreas, hkRotaPlaces, hkRotas, resources, users } from "../../kernel/db/schema";
import { dutiesOf } from "../roster";
import { openLoad } from "../tasks";
import { HousekeepingRefusal } from "./errors";
import { ancestry, areasOn, floorIn } from "./places";
import { parse, staffFacts } from "./setup";
import type { Actor, HkRotaMode, HkRotaView, HkSkill, RotaPlaceInput } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TaskEligibility, TaskRow } from "../tasks";
import type { Exec } from "./places";

/**
 * HK-1 (#973, decision 0086) — THE SHIFT ROTA. The supervisor places people for one shift: a whole floor, a route of
 * areas, or a section of beds; publishing it switches placement on for that shift. There is no fixed headcount: the
 * rota shows each person's open load. While a rota is published:
 *   · a task goes to the people placed on its place — those placed on the area or bed itself first, then the floor's
 *     floor-mode people, then anyone placed somewhere on that floor (`hkEligible`, the engine's `eligible` hook);
 *   · a trained skill narrows it: a class A area needs `critical`, a terminal clean `terminal`, a spill `spill`;
 *   · a discharge clean waits in the floor team's pool (`hkPoolOnly`): the team takes it, not one person by turn.
 * With no published rota, dispatch is as before (anyone on duty with the skill). DECIDED: someone placed without a
 * roster duty in the shift gets no tasks (the engine's own rule), and publishing warns the supervisor.
 */
type PlaceRow = typeof hkRotaPlaces.$inferSelect;

async function resolvePlace(exec: Exec, p: RotaPlaceInput): Promise<{ floorIds: string[]; floorId: string | null; areaIds: string[]; bedIds: string[] }> {
  if (p.mode === "floor") {
    const floor = (await (exec as Db).select({ kind: resources.kind }).from(resources).where(eq(resources.id, p.floorId)))[0];
    if (floor?.kind !== "floor") throw new HousekeepingRefusal("not_a_place", { resourceId: p.floorId });
    return { floorIds: [p.floorId], floorId: p.floorId, areaIds: [], bedIds: [] };
  }
  if (p.mode === "route") {
    const ids = [...new Set(p.areaIds)];
    const rows = await (exec as Db).select({ id: hkAreas.id, floorId: hkAreas.floorId }).from(hkAreas)
      .where(and(inArray(hkAreas.id, ids), eq(hkAreas.active, true)));
    if (rows.length !== ids.length) throw new HousekeepingRefusal("unknown_area", { areaIds: ids });
    return { floorIds: [...new Set(rows.map((r) => r.floorId).filter((f): f is string => f !== null))], floorId: null, areaIds: ids, bedIds: [] };
  }
  const ids = [...new Set(p.bedIds)];
  const floors = new Set<string>();
  for (const bedId of ids) {
    const chain = await ancestry(exec, bedId);
    if (chain[0]?.kind !== "bed") throw new HousekeepingRefusal("not_a_place", { resourceId: bedId });
    const f = floorIn(chain);
    if (f !== null) floors.add(f);
  }
  return { floorIds: [...floors], floorId: null, areaIds: [], bedIds: ids };
}

/** Save the draft rota of a shift (one draft per shift: saving again replaces its places). */
export async function saveRota(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<HkRotaView> {
  const input = parse(saveRotaInput, raw);
  const start = new Date(input.shiftStartsAt);
  const shift = hkShiftAt(start);
  if (shift.startsAt.getTime() !== start.getTime()) throw new HousekeepingRefusal("not_a_shift_start", { shiftStartsAt: input.shiftStartsAt });
  const userIds = input.places.map((p) => p.userId);
  if (new Set(userIds).size !== userIds.length) throw new HousekeepingRefusal("bad_input", { issues: ["places: a person is placed twice"] });
  if (userIds.length > 0) {
    const active = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, userIds), eq(users.active, true)));
    if (active.length !== userIds.length) throw new HousekeepingRefusal("unknown_person", {});
  }
  const rotaId = await withTx(db, async (tx) => {
    const resolved = [];
    for (const p of input.places) resolved.push({ userId: p.userId, mode: p.mode as HkRotaMode, ...(await resolvePlace(tx, p)) });
    const draft = (await tx.select().from(hkRotas).where(and(eq(hkRotas.shiftStartsAt, shift.startsAt), eq(hkRotas.status, "draft"))).for("update"))[0];
    const id = draft?.id ?? newId();
    if (draft === undefined) {
      await tx.insert(hkRotas).values({ id, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt, status: "draft", createdBy: actor.id, createdAt: now });
    } else {
      await tx.delete(hkRotaPlaces).where(eq(hkRotaPlaces.rotaId, id));
    }
    if (resolved.length > 0) await tx.insert(hkRotaPlaces).values(resolved.map((r) => ({ rotaId: id, ...r })));
    return id;
  });
  return rotaView(db, now, shift.startsAt, rotaId);
}

/** Publish a draft: it becomes the shift's rota (an older published one is superseded). */
export async function publishRota(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<HkRotaView> {
  const input = parse(publishRotaInput, raw);
  const rota = await withTx(db, async (tx) => {
    const row = (await tx.select().from(hkRotas).where(eq(hkRotas.id, input.rotaId)).for("update"))[0];
    if (row === undefined) throw new HousekeepingRefusal("unknown_rota", { rotaId: input.rotaId });
    if (row.status !== "draft") throw new HousekeepingRefusal("rota_published", { rotaId: row.id });
    await tx.update(hkRotas).set({ status: "superseded" })
      .where(and(eq(hkRotas.shiftStartsAt, row.shiftStartsAt), eq(hkRotas.status, "published")));
    await tx.update(hkRotas).set({ status: "published", publishedBy: actor.id, publishedAt: now }).where(eq(hkRotas.id, row.id));
    return row;
  });
  return rotaView(db, now, rota.shiftStartsAt, rota.id);
}

/** The published rota whose shift holds `at`, or null. */
export async function publishedRotaAt(exec: Exec, at: Date): Promise<{ id: string; places: PlaceRow[] } | null> {
  const rota = (await (exec as Db).select({ id: hkRotas.id }).from(hkRotas)
    .where(and(eq(hkRotas.status, "published"), lte(hkRotas.shiftStartsAt, at), gt(hkRotas.shiftEndsAt, at)))
    .orderBy(desc(hkRotas.publishedAt)).limit(1))[0];
  if (rota === undefined) return null;
  return { id: rota.id, places: await (exec as Db).select().from(hkRotaPlaces).where(eq(hkRotaPlaces.rotaId, rota.id)) };
}

/** People placed without a presence duty in the shift: they get no tasks. */
async function noDuty(exec: Exec, userIds: readonly string[], from: Date, to: Date): Promise<string[]> {
  const out: string[] = [];
  for (const u of userIds) {
    const duties = (await dutiesOf(exec, u, from, to)).filter((d) => d.kind !== "off" && d.mode === "presence" && d.startsAt < to && d.endsAt > from);
    if (duties.length === 0) out.push(u);
  }
  return out;
}

/** A shift's rota for the page: the draft if one is being made, else the published one, else none. */
export async function rotaView(db: Db, now: Date = new Date(), shiftStartsAt?: Date, rotaId?: string): Promise<HkRotaView> {
  const shift = hkShiftAt(shiftStartsAt ?? now);
  const rows = await db.select().from(hkRotas).where(rotaId !== undefined ? eq(hkRotas.id, rotaId)
    : and(eq(hkRotas.shiftStartsAt, shift.startsAt), inArray(hkRotas.status, ["draft", "published"])));
  const rota = rows.find((r) => r.status === "draft") ?? rows.find((r) => r.status === "published") ?? rows[0];
  const base = { shift: shift.key, shiftStartsAt: shift.startsAt.toISOString(), shiftEndsAt: shift.endsAt.toISOString() };
  if (rota === undefined) return { id: null, status: "none", ...base, places: [], warnings: [] };
  const places = await db.select({ p: hkRotaPlaces, name: users.fullName }).from(hkRotaPlaces)
    .innerJoin(users, eq(users.id, hkRotaPlaces.userId)).where(eq(hkRotaPlaces.rotaId, rota.id));
  const ids = places.map((x) => x.p.userId);
  const facts = await staffFacts(db, ids);
  const load = await openLoad(db, ids);
  const warnings = (await noDuty(db, ids, rota.shiftStartsAt, rota.shiftEndsAt)).map((userId) => ({ userId, code: "no_roster_duty" as const }));
  return {
    id: rota.id, status: rota.status === "draft" ? "draft" : "published", ...base,
    places: places.map(({ p, name }) => ({
      userId: p.userId, name, company: facts.get(p.userId)?.company ?? HK_IN_HOUSE, mode: p.mode as HkRotaMode, floorId: p.floorId,
      areaIds: p.areaIds, bedIds: p.bedIds, load: load.get(p.userId) ?? 0,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

/** The trained skill a task needs, if any. */
function skillNeeded(task: TaskRow, nearestClass: string | null): HkSkill | null {
  if (task.kind === HOUSEKEEPING_KINDS.terminal) return "terminal";
  if (task.kind === HOUSEKEEPING_KINDS.spill) return "spill";
  if (nearestClass === "A") return "critical";
  return null;
}

/** The engine's `eligible` hook for every housekeeping kind (see the header). */
export async function hkEligible(exec: Exec, task: TaskRow, now: Date): Promise<TaskEligibility | null> {
  const rota = await publishedRotaAt(exec, now);
  if (rota === null) return null;
  let places = rota.places;
  if (task.placeResourceId === null) return { userIds: places.map((p) => p.userId) };
  const chain = await ancestry(exec, task.placeResourceId);
  const chainIds = new Set(chain.map((p) => p.id));
  const areas = await areasOn(exec, chain);
  const areaIds = new Set(areas.map((a) => a.id));
  const need = skillNeeded(task, areas[0]?.areaClass ?? null);
  if (need !== null) {
    const facts = await staffFacts(exec, places.map((p) => p.userId));
    places = places.filter((p) => facts.get(p.userId)?.skills.includes(need) === true);
  }
  const floorId = floorIn(chain);
  const onPlace = places.filter((p) => p.bedIds.some((b) => chainIds.has(b)) || p.areaIds.some((a) => areaIds.has(a)));
  const onFloor = places.filter((p) => p.mode === "floor" && p.floorId !== null && p.floorId === floorId);
  const floorTeam = places.filter((p) => floorId !== null && p.floorIds.includes(floorId));
  const userIds = [...new Set([...onPlace, ...onFloor, ...floorTeam].map((p) => p.userId))];
  const preferred = (onPlace.length > 0 ? onPlace : onFloor).map((p) => p.userId);
  return { userIds, preferred };
}

/** The engine's `poolOnly` hook for the two bed-clean kinds: while a rota is published, the floor team takes them. */
export async function hkPoolOnly(exec: Exec, now: Date): Promise<boolean> {
  return (await publishedRotaAt(exec, now)) !== null;
}
