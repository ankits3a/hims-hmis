import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  ICU_BUNDLE_INTERVAL_MS, icuBundleDoneInput, icuLineInput, icuLineRemoveInput, icuSepsisInput, newId,
} from "@hmis/contracts";
import { icuBundles, icuDeviceLinks, icuLines, ipdAdmissions, ipdBedStays, resources } from "../../kernel/db/schema";
import { PLACED, parse, requireIcuPlacement, requirePermission } from "./common";
import { IcuError } from "./errors";
import { ICU_CARE } from "./permissions";
import type { Actor, IcuBundleKind, IcuBundleView } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D8) — CARE BUNDLES AND LINE-DAYS. Each bundle falls due per bed on its own clock while its trigger
 * stands (DECIDED, standard ICU practice — `ICU_BUNDLE_INTERVAL_MS`):
 *   ventilator   every 8 h while a ventilator is linked (head-up, sedation hold, oral care, cuff pressure)
 *   central_line every 24 h while a central line is in (dressing, need review)
 *   catheter     every 24 h while a urinary catheter is in (need review, closed system)
 *   dvt          every 24 h on an ICU bed (prophylaxis given or contraindicated)
 *   pressure     every 2 h on an ICU bed (turn, skin check)
 *   sepsis_hour1 once, 60 min from "sepsis suspected" (lactate, cultures, antibiotics, fluids, pressors)
 * The next one falls due one interval after the last was done (or after its trigger began). A bundle past its due instant
 * and not done is MISSED and shows on the in-charge view. Line-days and ventilator-days are counted (`deviceDays`).
 */

export async function insertLine(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ lineId: string }> {
  const input = parse(icuLineInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  await requireIcuPlacement(db, input.admissionId);
  const lineId = newId();
  await db.insert(icuLines).values({
    id: lineId, admissionId: input.admissionId, kind: input.kind, site: input.site,
    insertedAt: input.insertedAt !== undefined ? new Date(input.insertedAt) : now, insertedBy: actor.id,
  });
  return { lineId };
}

export async function removeLine(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<void> {
  const input = parse(icuLineRemoveInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  const line = (await db.select().from(icuLines).where(eq(icuLines.id, input.lineId)))[0];
  if (line === undefined) throw new IcuError("unknown_line");
  if (line.removedAt !== null) throw new IcuError("line_removed");
  await db.update(icuLines).set({ removedAt: input.removedAt !== undefined ? new Date(input.removedAt) : now, removedBy: actor.id })
    .where(and(eq(icuLines.id, line.id), isNull(icuLines.removedAt)));
}

export async function startSepsisBundle(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ bundleId: string; dueAt: string }> {
  const input = parse(icuSepsisInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  await requireIcuPlacement(db, input.admissionId);
  const from = input.suspectedAt !== undefined ? new Date(input.suspectedAt) : now;
  const bundleId = newId();
  const dueAt = new Date(from.getTime() + ICU_BUNDLE_INTERVAL_MS.sepsis_hour1);
  const won = await db.insert(icuBundles).values({ id: bundleId, admissionId: input.admissionId, kind: "sepsis_hour1", dueAt })
    .onConflictDoNothing().returning({ id: icuBundles.id });
  if (won.length === 0) throw new IcuError("sepsis_open");
  return { bundleId, dueAt: dueAt.toISOString() };
}

export async function completeBundle(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<void> {
  const input = parse(icuBundleDoneInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  const b = (await db.select().from(icuBundles).where(eq(icuBundles.id, input.bundleId)))[0];
  if (b === undefined) throw new IcuError("unknown_bundle");
  const done = await db.update(icuBundles).set({ doneAt: now, doneBy: actor.id, checks: input.checks, note: input.note ?? null })
    .where(and(eq(icuBundles.id, b.id), isNull(icuBundles.doneAt))).returning({ id: icuBundles.id });
  if (done.length === 0) throw new IcuError("bundle_done");
}

/** Every admission on an ICU bed now, with when its ICU stay began. */
export async function icuOccupants(db: Db): Promise<{ admissionId: string; bedId: string; since: Date }[]> {
  const rows = await db.select({ admissionId: ipdBedStays.admissionId, bedId: ipdBedStays.bedId, since: ipdBedStays.startedAt })
    .from(ipdBedStays)
    .innerJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdBedStays.admissionId))
    .where(and(isNull(ipdBedStays.endedAt), sql`(${resources.attributes}->>'icu') = 'true'`, inArray(ipdAdmissions.state, [...PLACED])));
  return rows;
}

/** Raise the next due bundle of every standing trigger. Idempotent (one open bundle per admission and kind). */
export async function ensureBundles(db: Db, now: Date = new Date()): Promise<number> {
  const occupants = await icuOccupants(db);
  let raised = 0;
  for (const o of occupants) {
    const anchors = new Map<IcuBundleKind, Date>([["dvt", o.since], ["pressure", o.since]]);
    const vent = (await db.select({ at: icuDeviceLinks.linkedAt }).from(icuDeviceLinks).where(and(
      eq(icuDeviceLinks.admissionId, o.admissionId), eq(icuDeviceLinks.deviceType, "ventilator"), isNull(icuDeviceLinks.endedAt),
    )).orderBy(asc(icuDeviceLinks.linkedAt)))[0];
    if (vent !== undefined) anchors.set("ventilator", vent.at);
    const lines = await db.select().from(icuLines).where(and(eq(icuLines.admissionId, o.admissionId), isNull(icuLines.removedAt)));
    const central = lines.filter((l) => l.kind === "central_line").sort((a, b) => a.insertedAt.getTime() - b.insertedAt.getTime())[0];
    const cath = lines.filter((l) => l.kind === "urinary_catheter").sort((a, b) => a.insertedAt.getTime() - b.insertedAt.getTime())[0];
    if (central !== undefined) anchors.set("central_line", central.insertedAt);
    if (cath !== undefined) anchors.set("catheter", cath.insertedAt);
    for (const [kind, anchor] of anchors) {
      if (anchor > now) continue;
      const open = (await db.select({ id: icuBundles.id }).from(icuBundles).where(and(
        eq(icuBundles.admissionId, o.admissionId), eq(icuBundles.kind, kind), isNull(icuBundles.doneAt),
      )))[0];
      if (open !== undefined) continue;
      const last = (await db.select({ doneAt: icuBundles.doneAt }).from(icuBundles).where(and(
        eq(icuBundles.admissionId, o.admissionId), eq(icuBundles.kind, kind), isNotNull(icuBundles.doneAt),
      )).orderBy(desc(icuBundles.doneAt)).limit(1))[0];
      const from = last?.doneAt !== undefined && last.doneAt !== null && last.doneAt > anchor ? last.doneAt : anchor;
      const won = await db.insert(icuBundles).values({
        id: newId(), admissionId: o.admissionId, kind, dueAt: new Date(from.getTime() + ICU_BUNDLE_INTERVAL_MS[kind]),
      }).onConflictDoNothing().returning({ id: icuBundles.id });
      raised += won.length;
    }
  }
  return raised;
}

/** The open bundles of an admission and those done in the last 24 hours. */
export async function bundlesOf(db: Db, admissionId: string, now: Date): Promise<IcuBundleView[]> {
  const rows = await db.select().from(icuBundles).where(eq(icuBundles.admissionId, admissionId)).orderBy(asc(icuBundles.dueAt));
  return rows.filter((b) => b.doneAt === null || now.getTime() - b.doneAt.getTime() < 24 * 3_600_000).map((b) => ({
    id: b.id, kind: b.kind as IcuBundleKind, dueAt: b.dueAt.toISOString(), doneAt: b.doneAt?.toISOString() ?? null, doneBy: b.doneBy,
    missed: b.doneAt === null && b.dueAt.getTime() < now.getTime(),
  }));
}

