import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { ICU_STORM_COUNT, ICU_STORM_WINDOW_MS } from "@hmis/contracts";
import {
  icuAlarmLimits, icuAlarms, icuBundles, icuFamilyUpdates, icuGateways, icuLines, icuNumericsMinute, icuVisitSlots, resources,
} from "../../kernel/db/schema";
import { activeLimits } from "./alarms";
import { bundlesOf, icuOccupants } from "./bundles";
import { hourDue } from "./chart";
import { istDay, patientWords, placementOf, requireIcuPlacement, requirePermission } from "./common";
import { deviceDays, openLinksOf } from "./devices";
import { IcuError } from "./errors";
import { hallFeed } from "./feed";
import { ICU_CARE, ICU_DECIDE, ICU_MANAGE, ICU_VIEW } from "./permissions";
import { listIcuRequests } from "./requests";
import type {
  Actor, IcuAlarmRung, IcuAlarmSeverity, IcuBedView, IcuBundleKind, IcuDeviceType, IcuHallSummary, IcuInchargeView, IcuLineKind,
  IcuMyBedsView, IcuNightView, IcuParam, IcuStationView, IcuTile, IcuTrendView,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984) — the screens' reads: the central station per hall (tiles: latest numbers, freshness, alarms, limits,
 * six-hour sparklines, bundles, the hour due), the one-bed view, 24-hour trends, the nurse's phone, the intensivist's
 * night view and the in-charge view. Every number shown comes from ATTRIBUTED rows only (D3).
 */

const SPARK_PARAMS: IcuParam[] = ["hr", "spo2", "nibp_map", "abp_map", "rr"];
const LATEST_WINDOW_MS = 10 * 60_000;

async function latestOf(db: Db, admissionId: string, now: Date): Promise<{ latest: IcuTile["latest"]; newest: Date | null }> {
  const rows = (await db.execute(sql`
    select distinct on (param) param, value, observed_at from icu_numerics
     where admission_id = ${admissionId} and technical is null and value is not null
       and observed_at > ${new Date(now.getTime() - LATEST_WINDOW_MS).toISOString()} and observed_at <= ${now.toISOString()}
     order by param, observed_at desc`)).rows as { param: IcuParam; value: number; observed_at: string | Date }[];
  const latest: IcuTile["latest"] = {};
  let newest: Date | null = null;
  for (const r of rows) {
    const at = new Date(r.observed_at);
    latest[r.param] = { value: Number(r.value), at: at.toISOString() };
    if (newest === null || at > newest) newest = at;
  }
  return { latest, newest };
}

async function tileOf(db: Db, admissionId: string, now: Date): Promise<IcuTile | null> {
  const p = await placementOf(db, admissionId);
  if (p === null) return null;
  const who = await patientWords(db, p.patientId);
  const { latest, newest } = await latestOf(db, admissionId, now);
  const links = await openLinksOf(db, admissionId);
  const alarms = await db.select().from(icuAlarms).where(and(eq(icuAlarms.admissionId, admissionId), eq(icuAlarms.state, "open")))
    .orderBy(desc(icuAlarms.raisedAt));
  const stormCount = (await db.select({ n: sql<number>`count(*)::int` }).from(icuAlarms).where(and(
    eq(icuAlarms.admissionId, admissionId), gte(icuAlarms.raisedAt, new Date(now.getTime() - ICU_STORM_WINDOW_MS)), lte(icuAlarms.raisedAt, now),
  )))[0]!.n;
  const limits = await activeLimits(db, admissionId, now);
  const minutes = await db.select().from(icuNumericsMinute).where(and(
    eq(icuNumericsMinute.admissionId, admissionId), inArray(icuNumericsMinute.param, SPARK_PARAMS),
    gte(icuNumericsMinute.minute, new Date(now.getTime() - 6 * 3_600_000)), lte(icuNumericsMinute.minute, now),
  )).orderBy(asc(icuNumericsMinute.minute));
  const spark: IcuTile["spark"] = {};
  for (const m of minutes) (spark[m.param as IcuParam] ??= []).push(m.value);
  const bundles = await bundlesOf(db, admissionId, now);
  const admitted = p.admittedAt ?? now;
  const dayOfStay = Math.max(1, Math.round((Date.parse(`${istDay(now)}T00:00:00+05:30`) - Date.parse(`${istDay(admitted)}T00:00:00+05:30`)) / 86_400_000) + 1);
  return {
    admissionId, patientName: who.name, uhid: who.uhid, bedId: p.bedId, bedName: p.bedName, dayOfStay, latest,
    freshnessSeconds: newest === null ? null : Math.max(0, Math.round((now.getTime() - newest.getTime()) / 1000)),
    devices: links.map((l) => ({ type: l.link.deviceType as IcuDeviceType, code: l.code, linkedAt: l.link.linkedAt.toISOString() })),
    openAlarms: alarms.map((a) => ({
      id: a.id, severity: a.severity as IcuAlarmSeverity, message: a.message, rung: a.rung as IcuAlarmRung, raisedAt: a.raisedAt.toISOString(),
      param: a.param as IcuParam | null,
    })),
    storm: stormCount >= ICU_STORM_COUNT,
    limits: limits.map((l) => ({ param: l.param as IcuParam, low: l.low, high: l.high, expiresAt: l.expiresAt.toISOString() })),
    spark,
    bundlesDue: bundles.filter((b) => b.doneAt === null && !b.missed).length,
    bundlesMissed: bundles.filter((b) => b.missed).length,
    hourDue: await hourDue(db, admissionId, now),
  };
}

const severityRank = (t: IcuTile): number => {
  const ranks = t.openAlarms.map((a) => ["life_threatening", "high", "medium", "low", "advisory"].indexOf(a.severity));
  return ranks.length === 0 ? 9 : Math.min(...ranks);
};

/** The beds of a hall (directly, or through its rooms). */
async function bedsOfHall(db: Db, hallId: string): Promise<{ id: string; name: string }[]> {
  const kids = await db.select().from(resources).where(eq(resources.parentId, hallId));
  const rooms = kids.filter((k) => k.kind === "room").map((k) => k.id);
  const inRooms = rooms.length === 0 ? [] : await db.select().from(resources).where(inArray(resources.parentId, rooms));
  return [...kids, ...inRooms].filter((r) => r.kind === "bed" && r.status !== "retired" && ((r.attributes ?? {}) as { icu?: boolean }).icu === true)
    .map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

async function hallTiles(db: Db, hallId: string, now: Date): Promise<IcuTile[]> {
  const beds = new Set((await bedsOfHall(db, hallId)).map((b) => b.id));
  const occupants = (await icuOccupants(db)).filter((o) => beds.has(o.bedId));
  const tiles = (await Promise.all(occupants.map((o) => tileOf(db, o.admissionId, now)))).filter((t): t is IcuTile => t !== null);
  return tiles.sort((a, b) => a.bedName.localeCompare(b.bedName, "en", { numeric: true }));
}

/** The halls that hold ICU beds (a ward or hall whose beds carry the ICU flag), with a one-line summary each. */
export async function listHalls(db: Db, actor: Actor, now: Date = new Date()): Promise<IcuHallSummary[]> {
  await requirePermission(db, actor, ICU_VIEW);
  const wards = await db.select().from(resources).where(eq(resources.kind, "ward"));
  const out: IcuHallSummary[] = [];
  for (const w of wards) {
    const beds = await bedsOfHall(db, w.id);
    if (beds.length === 0) continue;
    const tiles = await hallTiles(db, w.id, now);
    out.push({
      hallId: w.id, hallName: w.name, beds: beds.length, occupied: tiles.length, grey: (await hallFeed(db, w.id, now)).grey,
      openAlarms: tiles.reduce((s, t) => s + t.openAlarms.length, 0),
    });
  }
  return out.sort((a, b) => a.hallName.localeCompare(b.hallName));
}

export async function readStation(db: Db, actor: Actor, hallId: string, now: Date = new Date()): Promise<IcuStationView> {
  await requirePermission(db, actor, ICU_VIEW);
  const hall = (await db.select().from(resources).where(eq(resources.id, hallId)))[0];
  if (hall === undefined || hall.kind !== "ward") throw new IcuError("unknown_hall");
  const feed = await hallFeed(db, hallId, now);
  return {
    hallId, hallName: hall.name, asOf: now.toISOString(), grey: feed.grey, mode: feed.grey ? "manual" : "live",
    feedLastSeenAt: feed.lastSeenAt?.toISOString() ?? null, gapSince: feed.gapSince?.toISOString() ?? null,
    tiles: await hallTiles(db, hallId, now),
  };
}

export async function readBed(db: Db, actor: Actor, admissionId: string, now: Date = new Date()): Promise<IcuBedView> {
  await requirePermission(db, actor, ICU_VIEW);
  const p = await requireIcuPlacement(db, admissionId);
  const tile = (await tileOf(db, admissionId, now))!;
  const links = await openLinksOf(db, admissionId);
  const lines = await db.select().from(icuLines).where(eq(icuLines.admissionId, admissionId)).orderBy(asc(icuLines.insertedAt));
  const visits = await db.select().from(icuVisitSlots).where(eq(icuVisitSlots.admissionId, admissionId)).orderBy(desc(icuVisitSlots.startsAt)).limit(20);
  const updates = await db.select().from(icuFamilyUpdates).where(eq(icuFamilyUpdates.admissionId, admissionId)).orderBy(desc(icuFamilyUpdates.givenAt)).limit(14);
  return {
    tile, admissionNo: p.admissionNo, consultantId: p.consultantId,
    links: links.map((l) => ({
      id: l.link.id, type: l.link.deviceType as IcuDeviceType, deviceCode: l.code, deviceName: l.name, linkedAt: l.link.linkedAt.toISOString(), linkedBy: l.link.linkedBy,
    })),
    lines: lines.map((l) => ({ id: l.id, kind: l.kind as IcuLineKind, site: l.site, insertedAt: l.insertedAt.toISOString(), removedAt: l.removedAt?.toISOString() ?? null })),
    bundles: await bundlesOf(db, admissionId, now),
    days: await deviceDays(db, admissionId, now),
    visits: visits.map((v) => ({ id: v.id, startsAt: v.startsAt.toISOString(), endsAt: v.endsAt.toISOString(), visitorName: v.visitorName, relation: v.relation })),
    familyUpdates: updates.map((u) => ({ id: u.id, summary: u.summary, givenTo: u.givenTo, relation: u.relation, mode: u.mode, at: u.givenAt.toISOString(), by: u.givenBy })),
  };
}

/** 24-hour trends from the one-per-minute values (attributed only). */
export async function readTrends(db: Db, actor: Actor, admissionId: string, now: Date = new Date(), hours = 24): Promise<IcuTrendView> {
  await requirePermission(db, actor, ICU_VIEW);
  const from = new Date(now.getTime() - Math.min(Math.max(hours, 1), 72) * 3_600_000);
  const rows = await db.select().from(icuNumericsMinute).where(and(
    eq(icuNumericsMinute.admissionId, admissionId), gte(icuNumericsMinute.minute, from), lte(icuNumericsMinute.minute, now),
  )).orderBy(asc(icuNumericsMinute.minute));
  const series: IcuTrendView["series"] = {};
  for (const r of rows) (series[r.param as IcuParam] ??= []).push({ at: r.minute.toISOString(), value: r.value });
  return { admissionId, from: from.toISOString(), to: now.toISOString(), series };
}

/**
 * The nurse's phone. DECIDED: no nurse-to-bed assignment exists yet, so "my beds" is every occupied ICU bed, the ones
 * with open alarms first (life-threatening on top).
 */
export async function readMyBeds(db: Db, actor: Actor, now: Date = new Date()): Promise<IcuMyBedsView> {
  await requirePermission(db, actor, ICU_CARE);
  const occupants = await icuOccupants(db);
  const tiles = (await Promise.all(occupants.map((o) => tileOf(db, o.admissionId, now)))).filter((t): t is IcuTile => t !== null);
  tiles.sort((a, b) => severityRank(a) - severityRank(b) || a.bedName.localeCompare(b.bedName, "en", { numeric: true }));
  const halls = [...new Set(await Promise.all(tiles.map(async (t) => (await placementOf(db, t.admissionId))?.hallId ?? "")))].filter((h) => h !== "");
  const grey = (await Promise.all(halls.map((h) => hallFeed(db, h, now)))).some((f) => f.grey);
  return { asOf: now.toISOString(), tiles, grey };
}

/** The intensivist's night view: every hall's beds (sickest first) and the ICU requests waiting. */
export async function readNight(db: Db, actor: Actor, now: Date = new Date()): Promise<IcuNightView> {
  await requirePermission(db, actor, ICU_DECIDE);
  const halls = await listHalls(db, actor, now);
  const out: IcuNightView["halls"] = [];
  for (const h of halls) {
    const tiles = await hallTiles(db, h.hallId, now);
    tiles.sort((a, b) => severityRank(a) - severityRank(b));
    out.push({ hallId: h.hallId, hallName: h.hallName, grey: h.grey, tiles });
  }
  const requests = (await listIcuRequests(db, actor, now)).filter((r) => r.state === "pending" || r.state === "on_hold");
  return { asOf: now.toISOString(), halls: out, requests };
}

/** D8, D6, D7 — the in-charge's view: missed bundles, alarm storms, "set on the monitor" tasks, grey halls. */
export async function readIncharge(db: Db, actor: Actor, now: Date = new Date()): Promise<IcuInchargeView> {
  await requirePermission(db, actor, ICU_MANAGE);
  const occupants = await icuOccupants(db);
  const ids = occupants.map((o) => o.admissionId);
  const beds = new Map<string, string>();
  const names = new Map<string, string>();
  for (const o of occupants) {
    const p = await placementOf(db, o.admissionId);
    beds.set(o.admissionId, p?.bedName ?? "");
    if (p !== null) names.set(o.admissionId, (await patientWords(db, p.patientId)).name);
  }
  const missed = ids.length === 0 ? [] : await db.select().from(icuBundles).where(and(
    inArray(icuBundles.admissionId, ids), isNull(icuBundles.doneAt), lte(icuBundles.dueAt, now),
  )).orderBy(asc(icuBundles.dueAt));
  const storms: IcuInchargeView["storms"] = [];
  for (const id of ids) {
    const n = (await db.select({ n: sql<number>`count(*)::int` }).from(icuAlarms).where(and(
      eq(icuAlarms.admissionId, id), gte(icuAlarms.raisedAt, new Date(now.getTime() - ICU_STORM_WINDOW_MS)), lte(icuAlarms.raisedAt, now),
    )))[0]!.n;
    if (n >= ICU_STORM_COUNT) storms.push({ admissionId: id, bedName: beds.get(id) ?? "", count: n });
  }
  const tasks = ids.length === 0 ? [] : await db.select().from(icuAlarmLimits).where(and(
    inArray(icuAlarmLimits.admissionId, ids), isNull(icuAlarmLimits.supersededAt), isNull(icuAlarmLimits.monitorSetAt),
    lte(icuAlarmLimits.orderedAt, now), sql`${icuAlarmLimits.expiresAt} > ${now.toISOString()}`,
  )).orderBy(asc(icuAlarmLimits.orderedAt));
  const gateways = await db.select({ hallId: icuGateways.hallId, name: resources.name }).from(icuGateways)
    .innerJoin(resources, eq(resources.id, icuGateways.hallId)).where(eq(icuGateways.active, true));
  const greyHalls: IcuInchargeView["greyHalls"] = [];
  for (const g of gateways) {
    const f = await hallFeed(db, g.hallId, now);
    if (f.grey) greyHalls.push({ hallId: g.hallId, hallName: g.name, since: f.gapSince?.toISOString() ?? null });
  }
  return {
    asOf: now.toISOString(),
    missedBundles: missed.map((b) => ({
      bundleId: b.id, admissionId: b.admissionId, bedName: beds.get(b.admissionId) ?? "", patientName: names.get(b.admissionId) ?? "",
      kind: b.kind as IcuBundleKind, dueAt: b.dueAt.toISOString(),
    })),
    storms,
    monitorTasks: tasks.map((l) => ({
      limitId: l.id, admissionId: l.admissionId, bedName: beds.get(l.admissionId) ?? "", param: l.param as IcuParam, low: l.low, high: l.high,
      orderedAt: l.orderedAt.toISOString(),
    })),
    greyHalls,
  };
}

