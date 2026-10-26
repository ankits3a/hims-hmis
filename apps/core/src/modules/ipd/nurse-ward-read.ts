import { and, eq, inArray } from "drizzle-orm";
import { IPD_OVERLOAD_FACTOR } from "@hmis/contracts";
import { ipdWardRatioBreaches, patients, resources, users } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { whoIsAt } from "../roster";
import { requireIpdPermission } from "./admission-core";
import { initialsOf } from "./beds-board";
import { IpdBedAttributesSchema } from "./bed-attributes";
import {
  RN_ROLES, STUDENT_ROLES, acuityOf, liveMapsAt, liveRowsOf, mapFor, nextSlot, occupantsOf, ratioFor, shiftSlot, shiftSlotOf, staffOf,
} from "./nurse-ward";
import { rankNowRows } from "./now-cards";
import { readNurseStation, wardsWithBeds } from "./nursing-read";
import { IPD_NURSING_ASSIGN, IPD_NURSING_FLOAT } from "./permissions";
import type {
  Actor, IpdFloatPool, IpdNurseRef, IpdNurseShift, IpdShiftMapView, IpdWardCockpit,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DeskCard, DeskProviderCtx } from "../../kernel/desk/types";
import type { NowRow } from "./now-cards";

/**
 * WM-1 (#982) — THE WARD'S NURSES, READ: the in-charge cockpit (built on the nurse station's read, so identities,
 * scores, chips and "next due" follow ONE rule), the float pool, the shift map for the assignment screen, and the
 * bed → nurse lookup the station, my shift and the Beds board share. Read-only.
 */

export async function nurseRefs(db: Db, ids: readonly string[]): Promise<Map<string, IpdNurseRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((u) => [u.id, { userId: u.id, initials: initialsOf(u.name), name: u.name }] as const));
}

export type LiveNurses = {
  /** Wards with a live map for the shift now: only their occupied beds without a nurse show red. */
  wardsWithMap: Set<string>;
  byBed: Map<string, { nurse: IpdNurseRef; student: IpdNurseRef | null }>;
};

/** The nurse (and student) of every bed on a live map now. */
export async function liveNursesAt(db: Db, at: Date): Promise<LiveNurses> {
  const maps = await liveMapsAt(db, at);
  const rows = await liveRowsOf(db, [...maps.values()].map((m) => m.id));
  const refs = await nurseRefs(db, rows.flatMap((r) => [r.nurseId, ...(r.studentId === null ? [] : [r.studentId])]));
  const byBed = new Map(rows.flatMap((r) => {
    const nurse = refs.get(r.nurseId);
    return nurse === undefined ? [] : [[r.bedId, { nurse, student: r.studentId === null ? null : refs.get(r.studentId) ?? null }] as const];
  }));
  return { wardsWithMap: new Set(maps.keys()), byBed };
}

// ═══════════════════════════════════════════ the cockpit ═══════════════════════════════════════════

export async function readWardCockpit(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdWardCockpit> {
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const now = opts.now ?? new Date();
  const station = await readNurseStation(db, actor, { ...opts, now });
  const slot = shiftSlotOf(now);
  const shift = { key: slot.key, date: slot.date, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() };
  const empty: IpdWardCockpit = {
    asOf: now.toISOString(), wards: station.wards, ward: station.ward, shift, map: null, nextMap: null,
    census: { beds: 0, occupied: 0 },
    ratio: { unit: "general", night: slot.key === "night", patientsPerRn: 1, patients: 0, ventilated: 0, rnsOnDuty: 0, rnsNeeded: 0, breach: false },
    staff: [], loads: [], beds: [], needsYou: [], rosterFallback: false, candidates: [],
  };
  if (station.ward === null) return empty;
  const wardId = station.ward.id;
  const ward = (await db.select().from(resources).where(eq(resources.id, wardId)))[0]!;
  const { beds: allBeds } = await wardsWithBeds(db);
  const wardBeds = allBeds.filter((b) => b.wardId === wardId).map((b) => ({ id: b.id, code: b.code, class: IpdBedAttributesSchema.parse(b.attributes).class }));
  const current = await mapFor(db, wardId, slot);
  const live = current?.status === "draft" ? undefined : current;
  const next = await mapFor(db, wardId, nextSlot(slot));
  const staff = live === undefined ? [] : await staffOf(db, [live.id]);
  const rows = live === undefined ? [] : await liveRowsOf(db, [live.id]);
  const ratio = await ratioFor(db, { ward, beds: wardBeds }, slot, staff, rows, now);
  const occupants = await occupantsOf(db, wardBeds.map((b) => b.id));
  const acuity = await acuityOf(db, [...occupants.values()].map((o) => o.admissionId), now);
  const refs = await nurseRefs(db, [...staff.map((s) => s.userId), ...rows.flatMap((r) => [r.nurseId, ...(r.studentId === null ? [] : [r.studentId])])]);
  const rowByBed = new Map(rows.map((r) => [r.bedId, r] as const));

  // Load per registered nurse on duty: beds held and their acuity points.
  const onDuty = staff.filter((s) => s.endedAt === null && s.kind !== "student");
  const loads = onDuty.map((s) => {
    const mine = rows.filter((r) => r.nurseId === s.userId);
    const points = mine.reduce((sum, r) => {
      const o = occupants.get(r.bedId);
      return sum + (o === undefined ? 0 : acuity.get(o.admissionId)?.points ?? 0);
    }, 0);
    const ref = refs.get(s.userId) ?? { userId: s.userId, initials: "—", name: s.userId };
    return { ...ref, beds: mine.filter((r) => occupants.has(r.bedId)).length, points, overloaded: points > IPD_OVERLOAD_FACTOR * ratio.patientsPerRn, kind: s.kind };
  });
  const lightest = [...loads].filter((l) => l.kind !== "incharge")
    .sort((x, y) => x.points - y.points || x.beds - y.beds || x.name.localeCompare(y.name))[0]?.userId ?? null;

  const beds: IpdWardCockpit["beds"] = station.beds.map((b) => {
    const o = occupants.get(b.bedId);
    const r = rowByBed.get(b.bedId);
    const a = o === undefined ? undefined : acuity.get(o.admissionId);
    const unassigned = live !== undefined && o !== undefined && r === undefined;
    return {
      bedId: b.bedId, code: b.code, admissionId: o?.admissionId ?? null, name: b.patient?.name ?? null,
      nurse: r === undefined ? null : refs.get(r.nurseId) ?? null,
      student: r?.studentId == null ? null : refs.get(r.studentId) ?? null,
      unassigned, suggestedNurseId: unassigned ? lightest : null,
      acuity: a === undefined ? null : { level: a.level, points: a.points, ventilated: a.ventilated },
      score: b.score === null ? null : { value: b.score.value, band: b.score.band },
      chips: b.chips, next: b.next,
    };
  });

  const needsYou: IpdWardCockpit["needsYou"] = [];
  if (live === undefined) needsYou.push({ kind: "not_published", bedId: null, userId: null, text: "No nurse assignment published for this shift" });
  for (const b of beds.filter((x) => x.unassigned)) needsYou.push({ kind: "unassigned_bed", bedId: b.bedId, userId: null, text: `${b.code ?? "Bed"}: no nurse` });
  if (ratio.breach) needsYou.push({ kind: "ratio_breach", bedId: null, userId: null, text: `${String(ratio.rnsOnDuty)} of ${String(ratio.rnsNeeded)} nurses on duty` });
  for (const b of station.beds.filter((x) => x.alert !== null && x.alert.acknowledgedAt === null)) {
    needsYou.push({ kind: "ews", bedId: b.bedId, userId: null, text: `${b.code ?? "Bed"}: early warning` });
  }
  for (const l of loads.filter((x) => x.overloaded)) needsYou.push({ kind: "overloaded", bedId: null, userId: l.userId, text: `${l.initials}: ${String(l.points)} points` });
  for (const b of station.beds.filter((x) => x.next?.overdue === true)) {
    needsYou.push({ kind: "overdue", bedId: b.bedId, userId: null, text: `${b.code ?? "Bed"}: ${b.next!.kind} overdue` });
  }

  const cands = await candidatesFor(db, wardId, now);
  return {
    asOf: now.toISOString(), wards: station.wards, ward: station.ward, shift,
    map: live === undefined ? null : { mapId: live.id, status: live.status as "published", publishedAt: live.publishedAt?.toISOString() ?? null, late: live.late },
    nextMap: next === undefined ? null : { mapId: next.id, status: next.status as "draft" },
    census: { beds: wardBeds.length, occupied: occupants.size },
    ratio,
    staff: staff.map((s) => ({
      ...(refs.get(s.userId) ?? { userId: s.userId, initials: "—", name: s.userId }),
      kind: s.kind as "rn", pairedWithId: s.pairedWithId, homeWardId: s.homeWardId, endedAt: s.endedAt?.toISOString() ?? null,
    })),
    loads: loads.map((l) => ({ userId: l.userId, initials: l.initials, name: l.name, beds: l.beds, points: l.points, overloaded: l.overloaded })),
    beds, needsYou, rosterFallback: cands.fallback, candidates: cands.list,
  };
}

/**
 * The nurses the in-charge may put on the map: the roster's people at the ward (when the resolver answers), else every
 * active holder of the nursing roles (`fallback`, shown as a warning).
 */
async function candidatesFor(db: Db, wardId: string, at: Date): Promise<{ fallback: boolean; list: IpdWardCockpit["candidates"] }> {
  const roster = await whoIsAt(db, wardId, at);
  const byRole = new Map<string, Set<string>>();
  for (const role of ["ward_incharge", ...RN_ROLES, ...STUDENT_ROLES]) {
    byRole.set(role, new Set(await usersHoldingRole(db as never, role)));
  }
  const all = new Set([...byRole.values()].flatMap((s) => [...s]));
  const fallback = roster.userIds.length === 0;
  const ids = fallback ? [...all].filter((u) => !byRole.get("nursing_superintendent")!.has(u) || byRole.get("ward_nurse")!.has(u))
    : roster.userIds.filter((u) => all.has(u));
  const active = (await db.select({ id: users.id, active: users.active }).from(users).where(inArray(users.id, ids.length === 0 ? [""] : ids)))
    .filter((u) => u.active).map((u) => u.id);
  const refs = await nurseRefs(db, active);
  const rn = new Set(RN_ROLES.flatMap((r) => [...byRole.get(r)!]));
  const list = active.map((u) => ({
    ...refs.get(u)!,
    kind: byRole.get("ward_incharge")!.has(u) ? "incharge" as const : rn.has(u) ? "rn" as const : "student" as const,
  })).sort((x, y) => x.name.localeCompare(y.name));
  return { fallback, list };
}

// ═══════════════════════════════════════════ the float pool ═══════════════════════════════════════════

export async function readFloatPool(db: Db, actor: Actor, opts: { floorId?: string; now?: Date } = {}): Promise<IpdFloatPool> {
  await requireIpdPermission(db, actor, IPD_NURSING_FLOAT);
  const now = opts.now ?? new Date();
  const slot = shiftSlotOf(now);
  const maps = [...(await liveMapsAt(db, now)).values()];
  const wards = new Map((maps.length === 0 ? [] : await db.select().from(resources).where(inArray(resources.id, maps.map((m) => m.wardId)))).map((w) => [w.id, w] as const));
  const inScope = maps.filter((m) => opts.floorId === undefined || wards.get(m.wardId)?.parentId === opts.floorId);
  const staff = (await staffOf(db, inScope.map((m) => m.id))).filter((s) => s.endedAt === null && (s.kind === "rn" || s.kind === "float"));
  const rows = await liveRowsOf(db, inScope.map((m) => m.id));
  const occupants = await occupantsOf(db, rows.map((r) => r.bedId));
  const acuity = await acuityOf(db, [...occupants.values()].map((o) => o.admissionId), now);
  const refs = await nurseRefs(db, staff.map((s) => s.userId));
  const nurses = staff.map((s) => {
    const m = inScope.find((x) => x.id === s.mapId)!;
    const ward = wards.get(m.wardId)!;
    const mine = rows.filter((r) => r.mapId === s.mapId && r.nurseId === s.userId && occupants.has(r.bedId));
    return {
      ...(refs.get(s.userId) ?? { userId: s.userId, initials: "—", name: s.userId }),
      wardId: m.wardId, wardName: ward.name, floorId: ward.parentId, beds: mine.length,
      points: mine.reduce((sum, r) => sum + (acuity.get(occupants.get(r.bedId)!.admissionId)?.points ?? 0), 0),
    };
  }).sort((x, y) => x.points - y.points || x.beds - y.beds || x.name.localeCompare(y.name));
  return { asOf: now.toISOString(), shift: { key: slot.key, date: slot.date }, nurses };
}

// ═══════════════════════════════════════════ the assignment screen ═══════════════════════════════════════════

export async function readShiftMap(
  db: Db, actor: Actor, q: { wardId: string; shiftDate: string; shift: IpdNurseShift },
): Promise<IpdShiftMapView> {
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const m = await mapFor(db, q.wardId, shiftSlot(q.shiftDate, q.shift));
  const staff = m === undefined ? [] : await staffOf(db, [m.id]);
  const rows = m === undefined ? [] : await liveRowsOf(db, [m.id]);
  return {
    mapId: m?.id ?? null, wardId: q.wardId, shiftDate: q.shiftDate, shift: q.shift, status: (m?.status ?? null) as IpdShiftMapView["status"],
    staff: staff.filter((s) => s.endedAt === null).map((s) => ({ userId: s.userId, kind: s.kind as "rn", pairedWithId: s.pairedWithId })),
    beds: rows.map((r) => ({ bedId: r.bedId, nurseId: r.nurseId, studentId: r.studentId })),
  };
}

// ═══════════════════════════════════════════ the "Ward needs you" Now card ═══════════════════════════════════════════

/**
 * `ipd.ward_needs_you` (`ipd.nursing.assign`): per ward, an occupied bed with no nurse on the live map (hot, one row per
 * bed: the bed is the only words — a sealed patient's bed reads "Bed" alone), a ratio breach this shift (hot), and the
 * next shift's map not published 30 minutes before it (warn). Hospital-wide, top five; an empty card is not sent.
 */
export async function wardNeedsYouCard(ctx: DeskProviderCtx): Promise<DeskCard[]> {
  const { db, now } = ctx;
  const slot = shiftSlotOf(now);
  const maps = await liveMapsAt(db, now);
  if (maps.size === 0) return [];
  const { wards, beds } = await wardsWithBeds(db);
  const wardName = new Map(wards.map((w) => [w.id, w.name] as const));
  const rows = await liveRowsOf(db, [...maps.values()].map((m) => m.id));
  const held = new Set(rows.map((r) => r.bedId));
  const mapBeds = beds.filter((b) => maps.has(b.wardId));
  const occupants = await occupantsOf(db, mapBeds.map((b) => b.id));
  const sealed = new Set((occupants.size === 0 ? [] : await db.select({ id: patients.id }).from(patients)
    .where(and(inArray(patients.id, [...new Set([...occupants.values()].map((o) => o.patientId))]), eq(patients.sensitiveContext, true)))).map((p) => p.id));
  const out: NowRow[] = [];
  for (const b of mapBeds) {
    const o = occupants.get(b.id);
    if (o === undefined || held.has(b.id)) continue;
    out.push({
      id: `unassigned:${b.id}`, badge: "!", title: sealed.has(o.patientId) ? "Bed — no nurse" : `Bed ${b.code} — no nurse`,
      subtitle: wardName.get(b.wardId) ?? "", action: "Assign", href: `/ipd/ward/cockpit?ward=${b.wardId}`, severity: "hot", waitMinutes: 0,
    });
  }
  const breaches = await db.select().from(ipdWardRatioBreaches).where(and(eq(ipdWardRatioBreaches.shiftDate, slot.date), eq(ipdWardRatioBreaches.shift, slot.key)));
  for (const r of breaches) {
    out.push({
      id: `ratio:${r.wardId}`, badge: "!", title: `${wardName.get(r.wardId) ?? "Ward"} — nurses short`,
      subtitle: `${String(r.rnsOnDuty)} of ${String(r.rnsNeeded)} nurses`, action: "Open", href: `/ipd/ward/cockpit?ward=${r.wardId}`,
      severity: "hot", waitMinutes: Math.max(0, Math.floor((now.getTime() - r.raisedAt.getTime()) / 60_000)),
    });
  }
  const upcoming = nextSlot(slot);
  if (upcoming.startsAt.getTime() - now.getTime() <= 30 * 60_000) {
    for (const wardId of maps.keys()) {
      const next = await mapFor(db, wardId, upcoming);
      if (next !== undefined && next.status !== "draft") continue;
      out.push({
        id: `publish:${wardId}`, badge: "!", title: `${wardName.get(wardId) ?? "Ward"} — next shift not published`,
        subtitle: upcoming.key, action: "Assign", href: `/ipd/ward/assign?ward=${wardId}`, severity: "warn", waitMinutes: 0,
      });
    }
  }
  if (out.length === 0) return [];
  return [{ key: "ipd.ward_needs_you", band: "now", titleKey: "desk.ipdWardNeedsYou.title", rows: rankNowRows(out).slice(0, 5) }];
}
