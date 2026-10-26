import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  HK_INSPECTION_ITEMS, HK_INSPECT_CLASSES, HK_INSPECT_PASS_PCT, HK_INSPECT_PER_FLOOR, HOUSEKEEPING_KINDS, hkInspectionScore, hkShiftAt, newId,
  recordInspectionInput,
} from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { hkAreas, hkInspections, resources } from "../../kernel/db/schema";
import { raiseTask } from "../tasks";
import { HousekeepingRefusal } from "./errors";
import { HOUSEKEEPING_ROUNDS_ACTOR } from "./names";
import { parse, readQrToken } from "./setup";
import type { Actor, HkAreaClass, HkInspectionStatus, HkInspectionView, HkInspectionsView } from "@hmis/contracts";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db } from "../../kernel/db/client";
import type { Exec } from "./places";

/**
 * HK-2 (#974, decision 0086) — RANDOM INSPECTIONS. Toilets, public areas and support areas have no per-round check, so
 * the supervisor scores a random sample: each shift draws `HK_INSPECT_PER_FLOOR` (2, DECIDED) of each floor's active
 * C and D areas. The draw is SEEDED from the floor and the shift (a hash, not `Math.random`), and a floor that already has
 * a draw for the shift is skipped, so the clock's every-minute rerun draws nothing new — and the unique (area, shift)
 * index backs both. The supervisor scans the area's own door QR, answers the short NABH audit (`HK_INSPECTION_ITEMS`) and
 * takes one photo; the score is the share of Yes, and under `HK_INSPECT_PASS_PCT` (80 %) it fails. A fail raises a rework
 * task at the area (`area_rework`) on the floor team: proved with scan, checklist and photo, then checked by the
 * supervisor through HK-1's Pass/Fail path. The row keeps the COMPANY whose attendant last worked the area (the
 * contractor report's inspection score) — never a person.
 */
const PHOTO_PREFIX = "housekeeping/inspection/";
export const inspectionPhotoPrefix = (id: string): string => `${PHOTO_PREFIX}${id}/`;

const rank = (seed: string, areaId: string): string => createHash("sha256").update(`${seed}|${areaId}`).digest("hex");

/** Draw this shift's inspections for every floor that has none yet. Returns how many were drawn. */
export async function drawInspections(db: Db, now: Date = new Date()): Promise<{ drawn: number }> {
  const shift = hkShiftAt(now);
  const areas = await db.select({ id: hkAreas.id, floorId: hkAreas.floorId }).from(hkAreas)
    .where(and(eq(hkAreas.active, true), inArray(hkAreas.areaClass, [...HK_INSPECT_CLASSES])));
  const byFloor = new Map<string, string[]>();
  for (const a of areas) if (a.floorId !== null) byFloor.set(a.floorId, [...(byFloor.get(a.floorId) ?? []), a.id]);
  let drawn = 0;
  for (const [floorId, ids] of byFloor) {
    try {
      drawn += await withTx(db, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hk:inspect:${floorId}:${shift.startsAt.toISOString()}`}))`);
        const seen = await tx.select({ id: hkInspections.id }).from(hkInspections)
          .where(and(eq(hkInspections.floorId, floorId), eq(hkInspections.shiftStartsAt, shift.startsAt))).limit(1);
        if (seen.length > 0) return 0;
        const seed = `${floorId}|${shift.startsAt.toISOString()}`;
        const pick = [...ids].sort((a, b) => rank(seed, a).localeCompare(rank(seed, b))).slice(0, HK_INSPECT_PER_FLOOR);
        const rows = await tx.insert(hkInspections)
          .values(pick.map((areaId) => ({ id: newId(), areaId, floorId, shiftStartsAt: shift.startsAt, createdAt: now })))
          .onConflictDoNothing().returning({ id: hkInspections.id });
        return rows.length;
      });
    } catch (e) {
      console.error(`drawInspections: floor ${floorId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { drawn };
}

type Row = typeof hkInspections.$inferSelect;

async function views(exec: Exec, rows: Row[]): Promise<HkInspectionView[]> {
  if (rows.length === 0) return [];
  const areas = await (exec as Db).select({ id: hkAreas.id, areaClass: hkAreas.areaClass, name: resources.name })
    .from(hkAreas).innerJoin(resources, eq(resources.id, hkAreas.resourceId)).where(inArray(hkAreas.id, [...new Set(rows.map((r) => r.areaId))]));
  const areaOf = new Map(areas.map((a) => [a.id, a]));
  const floors = new Map((await (exec as Db).select({ id: resources.id, name: resources.name }).from(resources)
    .where(inArray(resources.id, [...new Set(rows.map((r) => r.floorId))]))).map((f) => [f.id, f.name]));
  return rows.map((r) => ({
    id: r.id, areaId: r.areaId, areaName: areaOf.get(r.areaId)?.name ?? "", areaClass: (areaOf.get(r.areaId)?.areaClass ?? "D") as HkAreaClass,
    floorId: r.floorId, floorName: floors.get(r.floorId) ?? null, shiftStartsAt: r.shiftStartsAt.toISOString(),
    status: r.status as HkInspectionStatus, scorePct: r.scorePct, inspectedAt: r.inspectedAt?.toISOString() ?? null,
    company: r.company, reworkTaskId: r.reworkTaskId,
  }));
}

/** The inspections drawn for the shift holding `now`, by floor then area. */
export async function inspectionsOf(db: Db, now: Date = new Date()): Promise<HkInspectionsView> {
  const shift = hkShiftAt(now);
  const rows = await db.select().from(hkInspections).where(eq(hkInspections.shiftStartsAt, shift.startsAt)).orderBy(asc(hkInspections.floorId), asc(hkInspections.createdAt));
  return { serverNow: now.toISOString(), shiftStartsAt: shift.startsAt.toISOString(), inspections: await views(db, rows) };
}

/** Store the inspection photo (the place, never a patient). Returns its key. */
export async function storeInspectionPhoto(
  db: Db, store: DocumentStore, _actor: Actor, input: { inspectionId: string; mime: string; bytes: Buffer },
): Promise<{ photoKey: string }> {
  const row = (await db.select({ id: hkInspections.id, status: hkInspections.status }).from(hkInspections).where(eq(hkInspections.id, input.inspectionId)))[0];
  if (row === undefined) throw new HousekeepingRefusal("unknown_inspection", { inspectionId: input.inspectionId });
  if (row.status !== "due") throw new HousekeepingRefusal("inspection_done", { inspectionId: row.id });
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.mime) || input.bytes.length === 0 || input.bytes.length > 5 * 1024 * 1024) {
    throw new HousekeepingRefusal("bad_input", { issues: ["photo: a JPEG, PNG or WebP image up to 5 MB"] });
  }
  const ext = input.mime === "image/png" ? "png" : input.mime === "image/webp" ? "webp" : "jpg";
  const photoKey = `${inspectionPhotoPrefix(row.id)}${newId()}.${ext}`;
  await store.put(photoKey, input.bytes);
  return { photoKey };
}

/** The company whose attendant last finished work at this place or inside it (null: nobody has). */
async function lastCompanyAt(exec: Exec, resourceId: string): Promise<{ company: string; contractorId: string | null } | null> {
  const res = await (exec as Db).execute<{ company: string; contractor_id: string | null }>(sql`
    with recursive tree(id, depth) as (
      select id, 0 from resources where id = ${resourceId}
      union all
      select r.id, t.depth + 1 from resources r join tree t on r.parent_id = t.id where t.depth < 8
    )
    select w.company, w.contractor_id from hk_work w join tasks k on k.id = w.task_id
     where k.place_resource_id in (select id from tree)
     order by w.scanned_at desc limit 1`);
  const r = res.rows[0];
  return r === undefined ? null : { company: r.company, contractorId: r.contractor_id };
}

/** Score an inspection: the area's own QR, every audit item, one photo. A fail raises the rework on the floor team. */
export async function recordInspection(db: Db, key: Buffer, actor: Actor, raw: unknown, now: Date = new Date()): Promise<HkInspectionView> {
  const input = parse(recordInspectionInput, raw);
  const row = await withTx(db, async (tx) => {
    const ins = (await tx.select().from(hkInspections).where(eq(hkInspections.id, input.inspectionId)).for("update"))[0];
    if (ins === undefined) throw new HousekeepingRefusal("unknown_inspection", { inspectionId: input.inspectionId });
    if (ins.status !== "due") throw new HousekeepingRefusal("inspection_done", { inspectionId: ins.id });
    const scanned = await readQrToken(tx, key, input.scan);
    if (scanned.id !== ins.areaId) throw new HousekeepingRefusal("wrong_place", { inspectionId: ins.id, areaId: scanned.id });
    const known = new Set<string>(HK_INSPECTION_ITEMS.map((i) => i.id));
    const answers = input.answers.filter((a) => known.has(a.itemId));
    if (new Set(answers.map((a) => a.itemId)).size !== known.size) throw new HousekeepingRefusal("checklist_incomplete", { inspectionId: ins.id });
    if (input.photoKey === undefined) throw new HousekeepingRefusal("photo_missing", { inspectionId: ins.id });
    if (!input.photoKey.startsWith(inspectionPhotoPrefix(ins.id))) throw new HousekeepingRefusal("bad_input", { issues: ["photoKey: not this inspection's photo"] });
    const ordered = HK_INSPECTION_ITEMS.map((i) => answers.find((a) => a.itemId === i.id)!);
    const scorePct = hkInspectionScore(ordered);
    const passed = scorePct >= HK_INSPECT_PASS_PCT;
    const who = await lastCompanyAt(tx, scanned.resourceId);
    let reworkTaskId: string | null = null;
    if (!passed) {
      const misses = HK_INSPECTION_ITEMS.filter((i) => !ordered.find((a) => a.itemId === i.id)!.ok).map((i) => i.text);
      const { task } = await raiseTask(tx, HOUSEKEEPING_ROUNDS_ACTOR, {
        kind: HOUSEKEEPING_KINDS.rework, placeResourceId: scanned.resourceId, sourceRef: `hk-rework:${ins.id}`,
        note: `Inspection ${String(scorePct)} %: ${misses.join("; ")}`.slice(0, 280),
      }, now);
      reworkTaskId = task.id;
    }
    return (await tx.update(hkInspections).set({
      status: passed ? "passed" : "failed", answers: ordered, scorePct, photoKey: input.photoKey, qrVersion: scanned.qrVersion,
      inspectedBy: actor.id, inspectedAt: now, company: who?.company ?? null, contractorId: who?.contractorId ?? null, reworkTaskId,
    }).where(eq(hkInspections.id, ins.id)).returning())[0]!;
  });
  return (await views(db, [row]))[0]!;
}

/** For the contractor report: inspections scored in a window, with their company. */
export async function inspectionsScoredBetween(db: Db, from: Date, to: Date): Promise<Row[]> {
  return db.select().from(hkInspections)
    .where(and(sql`${hkInspections.inspectedAt} >= ${from.toISOString()}::timestamptz`, sql`${hkInspections.inspectedAt} < ${to.toISOString()}::timestamptz`));
}

/** For the daily report: a floor's inspections of one shift. */
export async function inspectionsOfFloorShift(db: Db, floorId: string, shiftStartsAt: Date): Promise<Row[]> {
  return db.select().from(hkInspections).where(and(eq(hkInspections.floorId, floorId), eq(hkInspections.shiftStartsAt, shiftStartsAt)));
}

