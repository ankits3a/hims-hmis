import { and, desc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { IPD_EWS_ANSWER_MINUTES, IPD_HANDOVER_ON_TIME_MINUTES } from "@hmis/contracts";
import {
  ipdBedStays, ipdNursingAlerts, ipdRestraints, ipdSafetyEvents, ipdShiftHandovers, ipdWardIncidents, ipdWardRatioBreaches, ipdWardShiftMaps, resources, users,
} from "../../kernel/db/schema";
import { requireIpdPermission } from "./admission-core";
import { IpdError } from "./errors";
import { readNurseStation, wardsWithBeds } from "./nursing-read";
import { IPD_NURSING_ASSIGN, IPD_WARD_QUALITY } from "./permissions";
import { crashCartsOf, narcoticKeysOf } from "./ward-cart";
import { linesOf, wardLineDays } from "./ward-lines";
import { carePlansOf, monthBounds, restraintViews } from "./ward-safety";
import type { Actor, IpdWardQuality, IpdWardSafety } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * WM-2 (#983) — THE WARD'S READS: the in-charge's safety screen (care plans with their next check, restraints, lines with
 * "still needed?", crash carts, who holds the narcotic keys, recent incidents) and the MONTHLY QUALITY READ.
 *
 * QUALITY (NABH key performance indicators, DECIDED definitions; month in IST, up to `now` for the current month):
 * - BED-DAYS: the exact overlap (in days, two decimals) of every stay on the ward's beds with the month.
 * - FALLS, NEW PRESSURE INJURIES, MEDICATION ERRORS: safety events on the ward in the month, NOT present on admission,
 *   per 1,000 bed-days. LINE INFECTIONS per 1,000 line-days (`wardLineDays`).
 * - EWS ANSWERED IN TIME: early-warning alerts raised in the month for a patient on the ward, acknowledged by a doctor
 *   (or seen) within 10 minutes, as a percentage.
 * - HANDOVERS ON TIME: shift handovers given on the ward in the month (not superseded), accepted within 30 minutes.
 * - SHIFTS WITH RATIO KEPT: the ward's live shift maps of the month with no ratio-breach row.
 * Every indicator carries the ids of the rows it counts (`sources`).
 */

const r2 = (n: number): number => Math.round(n * 100) / 100;
const per1000 = (count: number, over: number): number | null => (over <= 0 ? null : r2((count * 1000) / over));
const pct = (count: number, over: number): number | null => (over <= 0 ? null : r2((count * 100) / over));

export async function readWardQuality(db: Db, actor: Actor, q: { wardId: string; month: string; now?: Date }): Promise<IpdWardQuality> {
  await requireIpdPermission(db, actor, IPD_WARD_QUALITY);
  const now = q.now ?? new Date();
  const ward = (await db.select().from(resources).where(eq(resources.id, q.wardId)))[0];
  if (ward === undefined || (ward.kind !== "ward" && ward.kind !== "hall")) throw new IpdError("ward_not_found", "no ward has this id", { wardId: q.wardId });
  const { from, to } = monthBounds(q.month);
  const end = new Date(Math.min(to.getTime(), now.getTime()));
  const { beds } = await wardsWithBeds(db);
  const bedIds = beds.filter((b) => b.wardId === ward.id).map((b) => b.id);

  // Bed-days: the stays on the ward's beds overlapping the month.
  const stays = bedIds.length === 0 ? [] : await db.select().from(ipdBedStays).where(and(
    inArray(ipdBedStays.bedId, bedIds), lt(ipdBedStays.startedAt, end), or(isNull(ipdBedStays.endedAt), gte(ipdBedStays.endedAt, from)),
  ));
  let ms = 0;
  for (const s of stays) {
    const a = Math.max(s.startedAt.getTime(), from.getTime());
    const b = Math.min((s.endedAt ?? end).getTime(), end.getTime());
    if (b > a) ms += b - a;
  }
  const bedDays = r2(ms / 86_400_000);

  // Safety events of the month on this ward.
  const events = await db.select().from(ipdSafetyEvents).where(and(eq(ipdSafetyEvents.wardId, ward.id), gte(ipdSafetyEvents.occurredAt, from), lt(ipdSafetyEvents.occurredAt, end)));
  const counted = (kind: string): string[] => events.filter((e) => e.kind === kind && !e.presentOnAdmission).map((e) => e.id).sort();
  const lines = await wardLineDays(db, ward.id, from, to, now);

  // EWS alerts raised for a patient whose stay at that instant was on this ward.
  const alerts = stays.length === 0 ? [] : await db.select().from(ipdNursingAlerts).where(and(
    eq(ipdNursingAlerts.kind, "ews"), inArray(ipdNursingAlerts.admissionId, [...new Set(stays.map((s) => s.admissionId))]),
    gte(ipdNursingAlerts.raisedAt, from), lt(ipdNursingAlerts.raisedAt, end),
  ));
  const onWard = alerts.filter((al) => stays.some((s) => s.admissionId === al.admissionId && s.startedAt <= al.raisedAt && (s.endedAt === null || s.endedAt > al.raisedAt)));
  const answered = onWard.filter((al) => {
    const t = al.acknowledgedAt ?? al.seenAt;
    return t !== null && t.getTime() - al.raisedAt.getTime() <= IPD_EWS_ANSWER_MINUTES * 60_000;
  }).map((al) => al.id).sort();

  const handovers = await db.select().from(ipdShiftHandovers).where(and(
    eq(ipdShiftHandovers.wardId, ward.id), ne(ipdShiftHandovers.status, "superseded"), gte(ipdShiftHandovers.givenAt, from), lt(ipdShiftHandovers.givenAt, end),
  ));
  const onTime = handovers.filter((h) => h.acceptedAt !== null && h.acceptedAt.getTime() - h.givenAt.getTime() <= IPD_HANDOVER_ON_TIME_MINUTES * 60_000).map((h) => h.id).sort();

  const dayFrom = q.month + "-01";
  const dayTo = new Date(to.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const maps = await db.select().from(ipdWardShiftMaps).where(and(
    eq(ipdWardShiftMaps.wardId, ward.id), ne(ipdWardShiftMaps.status, "draft"), gte(ipdWardShiftMaps.shiftDate, dayFrom), lt(ipdWardShiftMaps.shiftDate, dayTo),
  ));
  const breaches = await db.select().from(ipdWardRatioBreaches).where(and(
    eq(ipdWardRatioBreaches.wardId, ward.id), gte(ipdWardRatioBreaches.shiftDate, dayFrom), lt(ipdWardRatioBreaches.shiftDate, dayTo),
  ));
  const breached = new Set(breaches.map((b) => `${b.shiftDate}:${b.shift}`));
  const kept = maps.filter((m) => !breached.has(`${m.shiftDate}:${m.shift}`)).map((m) => m.id).sort();

  const bd = (ids: string[]) => ({ count: ids.length, over: bedDays, value: per1000(ids.length, bedDays), unit: "per_1000_bed_days" as const, sources: ids });
  const infections = counted("line_infection");
  return {
    wardId: ward.id, wardName: ward.name, month: q.month, bedDays, lineDays: lines.total,
    indicators: {
      falls: bd(counted("fall")),
      pressureInjuries: bd(counted("pressure_injury")),
      medicationErrors: bd(counted("medication_error")),
      lineInfections: { count: infections.length, over: lines.total, value: per1000(infections.length, lines.total), unit: "per_1000_line_days", sources: infections },
      ewsAnsweredInTime: { count: answered.length, over: onWard.length, value: pct(answered.length, onWard.length), unit: "percent", sources: answered },
      handoversOnTime: { count: onTime.length, over: handovers.length, value: pct(onTime.length, handovers.length), unit: "percent", sources: onTime },
      shiftsRatioKept: { count: kept.length, over: maps.length, value: pct(kept.length, maps.length), unit: "percent", sources: kept },
    },
    presentOnAdmission: events.filter((e) => e.presentOnAdmission).map((e) => e.id).sort(),
  };
}

/** The in-charge's ward safety screen. Identities and bed codes come from the nurse station (one masking rule). */
export async function readWardSafety(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdWardSafety> {
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const now = opts.now ?? new Date();
  const station = await readNurseStation(db, actor, { ...opts, now });
  // A ward with no bed loaded yet still has its carts and keys: an explicit ward id is honoured.
  let ward = station.ward;
  if (ward === null && opts.wardId !== undefined) {
    const r = (await db.select().from(resources).where(eq(resources.id, opts.wardId)))[0];
    if (r !== undefined && (r.kind === "ward" || r.kind === "hall")) ward = { id: r.id, code: r.code, name: r.name };
  }
  const patients = station.beds.filter((b) => b.patient !== null)
    .map((b) => ({ admissionId: b.patient!.admissionId, bedCode: b.patient!.sealed ? null : b.code, name: b.patient!.name }));
  const base: IpdWardSafety = { asOf: now.toISOString(), wards: station.wards, ward, patients, carePlans: [], restraints: [], lines: [], carts: [], keys: null, incidents: [] };
  if (ward === null) return base;
  const wardId = ward.id;
  const who = new Map(station.beds.filter((b) => b.patient !== null).map((b) => [b.patient!.admissionId, {
    bedCode: b.patient!.sealed ? null : b.code, name: b.patient!.name,
  }] as const));
  const ids = [...who.keys()];
  const plans = await carePlansOf(db, ids, now);
  const restraintRows = ids.length === 0 ? [] : await db.select().from(ipdRestraints)
    .where(and(inArray(ipdRestraints.admissionId, ids), inArray(ipdRestraints.status, ["ordered", "active", "lapsed"])));
  const lines = await linesOf(db, ids, now);
  const keys = await narcoticKeysOf(db, wardId);
  const keyName = keys === null ? null : (await db.select({ name: users.fullName }).from(users).where(eq(users.id, keys.userId)))[0]?.name ?? keys.userId;
  const incidents = await db.select().from(ipdWardIncidents).where(eq(ipdWardIncidents.wardId, wardId)).orderBy(desc(ipdWardIncidents.raisedAt)).limit(10);
  const plain = (id: string) => who.get(id) ?? { bedCode: null, name: "" };
  return {
    ...base,
    carePlans: plans.map((p) => ({ ...p, ...plain(p.admissionId) })).sort((x, y) => Number(y.overdue) - Number(x.overdue) || x.nextDueAt.localeCompare(y.nextDueAt)),
    restraints: await restraintViews(db, restraintRows, now, who),
    lines: lines.map((l) => ({ ...l, ...plain(l.admissionId) })),
    carts: await crashCartsOf(db, wardId, now),
    keys: keys === null ? null : { userId: keys.userId, name: keyName ?? "", takenAt: keys.takenAt.toISOString() },
    incidents: incidents.map((i) => ({ incidentId: i.id, kind: i.kind, text: i.text, raisedAt: i.raisedAt.toISOString() })),
  };
}
