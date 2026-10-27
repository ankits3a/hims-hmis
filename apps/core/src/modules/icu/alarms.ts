import { and, asc, eq, gt, gte, isNull, lte, ne, sql } from "drizzle-orm";
import {
  ICU_ADVISORY_SUSTAIN_MS, ICU_LIMIT_TTL_MS, ICU_PARAM_UNITS, ICU_RUNG_CLOCK_MS, ICU_STORM_COUNT, ICU_STORM_WINDOW_MS, icuAckInput,
  icuLimitInput, newId,
} from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import {
  icuAlarmEvents, icuAlarmLimits, icuAlarms, icuFeedGaps, icuGateways, icuNumerics, interfaces, ipdAdmissions,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { dutyDoctorsFor } from "../ipd";
import { ICU_SYSTEM, inTx, parse, requireIcuPlacement, requirePermission, usersWithRole } from "./common";
import { IcuError } from "./errors";
import { icuAlarmAcknowledged, icuAlarmEscalated, icuAlarmRaised, icuFeedGapClosed, icuFeedGapOpened } from "./events";
import { ICU_CARE, ICU_DECIDE } from "./permissions";
import type { Actor, IcuAlarmRung, IcuAlarmSeverity, IcuParam } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D5, D6) — THE ALARM LADDER AND THE DOCTOR'S LIMITS.
 *
 * An alarm is a task with a clock. A LIFE-THREATENING alarm (classified only by the device — decision 0090) climbs
 * bed nurse (60 s) → station (60 s) → duty doctor (120 s) → intensivist, until a person acknowledges it; every other alarm
 * stays with the bed nurse. HMIS records WHO acknowledged and WHEN, and NEVER silences a device: there is no silence act,
 * no silence column, and the gateway receives no command — the monitor sounds the real alarm.
 *
 * Who is told (DECIDED, standard practice): the bed nurse sees the alarm on the station and the phone (no notice — the
 * nurse is at the bed); the STATION rung tells the hall's ICU in-charge (`icu_incharge`, else `nursing_supervisor`); the
 * DUTY DOCTOR rung tells the admission's duty doctors (`dutyDoctorsFor`: the consultant and the rostered ward JR); the
 * INTENSIVIST rung tells every `intensivist`. One notice per alarm per rung.
 *
 * ADVISORY alarms (until a vendor exports its alarms over HL7 — a purchase requirement in 0090): a breach of the doctor's
 * limit sustained 20 s in the stored numbers. A doctor-set limit lasts 24 hours (D6) and raises the nurse's task "set
 * the same limit on the monitor". An ALARM STORM (10 alarms on one bed in 10 minutes) is flagged to the in-charge once per
 * window, and advisory alarms on that bed are capped while it lasts.
 */

const NEXT: Record<Exclude<IcuAlarmRung, "intensivist">, IcuAlarmRung> = { bed_nurse: "station", station: "duty_doctor", duty_doctor: "intensivist" };

type AlarmInput = {
  admissionId: string; patientId: string; bedId: string; source: "device" | "advisory"; severity: IcuAlarmSeverity;
  param: IcuParam | null; message: string; at: Date; limitId?: string;
};

async function stormActive(tx: Tx, admissionId: string, at: Date): Promise<boolean> {
  const since = new Date(at.getTime() - ICU_STORM_WINDOW_MS);
  const n = (await tx.select({ n: sql<number>`count(*)::int` }).from(icuAlarms)
    .where(and(eq(icuAlarms.admissionId, admissionId), gte(icuAlarms.raisedAt, since), lte(icuAlarms.raisedAt, at))))[0]!.n;
  return n >= ICU_STORM_COUNT;
}

async function stationPeople(tx: Tx): Promise<string[]> {
  const incharge = await usersWithRole(tx, "icu_incharge");
  return incharge.length > 0 ? incharge : usersWithRole(tx, "nursing_supervisor");
}

/** Raise one alarm (deduplicated: the same open alarm is not raised twice) and flag a storm. Returns the id or null. */
export async function raiseAlarm(tx: Tx, a: AlarmInput): Promise<string | null> {
  const same = (await tx.select({ id: icuAlarms.id }).from(icuAlarms).where(and(
    eq(icuAlarms.admissionId, a.admissionId), eq(icuAlarms.state, "open"), eq(icuAlarms.source, a.source),
    eq(icuAlarms.severity, a.severity), eq(icuAlarms.message, a.message),
  )))[0];
  if (same !== undefined) return null;
  if (a.source === "advisory" && await stormActive(tx, a.admissionId, a.at)) return null;
  const id = newId();
  await tx.insert(icuAlarms).values({
    id, admissionId: a.admissionId, bedId: a.bedId, source: a.source, severity: a.severity, param: a.param, message: a.message,
    raisedAt: a.at, rung: "bed_nurse", rungSince: a.at, state: "open", limitId: a.limitId ?? null,
  });
  await tx.insert(icuAlarmEvents).values({ id: newId(), alarmId: id, admissionId: a.admissionId, act: "raised", rung: "bed_nurse", actorId: null, at: a.at });
  await appendEvent(tx, icuAlarmRaised.make({
    payload: { alarmId: id, admissionId: a.admissionId, source: a.source, severity: a.severity },
    actor: ICU_SYSTEM, correlationId: a.admissionId, patientId: a.patientId, occurredAt: a.at,
  }));
  if (await stormActive(tx, a.admissionId, a.at)) {
    const since = new Date(a.at.getTime() - ICU_STORM_WINDOW_MS);
    const flagged = (await tx.select({ id: icuAlarmEvents.id }).from(icuAlarmEvents).where(and(
      eq(icuAlarmEvents.admissionId, a.admissionId), eq(icuAlarmEvents.act, "storm_flagged"), gte(icuAlarmEvents.at, since),
    )))[0];
    if (flagged === undefined) {
      const eventId = newId();
      await tx.insert(icuAlarmEvents).values({ id: eventId, alarmId: null, admissionId: a.admissionId, act: "storm_flagged", rung: null, actorId: null, at: a.at });
      for (const userId of await stationPeople(tx)) {
        await raiseNoticeIn(tx, {
          userId, kind: "icu.alarm_storm", title: "ICU alarm storm", body: `${String(ICU_STORM_COUNT)}+ alarms in 10 min on one bed — review the limits`,
          refType: "ipd_admission", refId: a.admissionId, sourceKey: `icu.storm:${eventId}`, at: a.at,
        });
      }
    }
  }
  return id;
}

/** The limits standing at `at` (not superseded, not expired). */
export async function activeLimits(db: Db | Tx, admissionId: string, at: Date) {
  return (db as Db).select().from(icuAlarmLimits).where(and(
    eq(icuAlarmLimits.admissionId, admissionId), isNull(icuAlarmLimits.supersededAt), lte(icuAlarmLimits.orderedAt, at), gt(icuAlarmLimits.expiresAt, at),
  )).orderBy(asc(icuAlarmLimits.param));
}

const breaches = (v: number, l: { low: number | null; high: number | null }): boolean => (l.low !== null && v < l.low) || (l.high !== null && v > l.high);

/** D6 — a breach of a standing limit sustained `ICU_ADVISORY_SUSTAIN_MS` up to the latest sample raises an advisory alarm. */
export async function evaluateAdvisory(
  tx: Tx, t: { admissionId: string; patientId: string; bedId: string; latest: Map<IcuParam, Date> },
): Promise<void> {
  for (const [param, latest] of t.latest) {
    const limit = (await activeLimits(tx, t.admissionId, latest)).find((l) => l.param === param);
    if (limit === undefined) continue;
    const from = new Date(latest.getTime() - ICU_ADVISORY_SUSTAIN_MS);
    const rows = await tx.select({ value: icuNumerics.value, at: icuNumerics.observedAt }).from(icuNumerics).where(and(
      eq(icuNumerics.admissionId, t.admissionId), eq(icuNumerics.param, param), gte(icuNumerics.observedAt, from), lte(icuNumerics.observedAt, latest),
      isNull(icuNumerics.technical),
    )).orderBy(asc(icuNumerics.observedAt));
    if (rows.length < 2 || latest.getTime() - rows[0]!.at.getTime() < ICU_ADVISORY_SUSTAIN_MS) continue;
    if (!rows.every((r) => r.value !== null && breaches(r.value, limit))) continue;
    const last = rows.at(-1)!.value!;
    const side = limit.high !== null && last > limit.high ? `above ${String(limit.high)}` : `below ${String(limit.low)}`;
    await raiseAlarm(tx, {
      admissionId: t.admissionId, patientId: t.patientId, bedId: t.bedId, source: "advisory", severity: "advisory", param,
      message: `${param.toUpperCase()} ${String(last)} ${ICU_PARAM_UNITS[param]} ${side} for 20 s`, at: latest, limitId: limit.id,
    });
  }
}

export async function setAlarmLimit(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ limitId: string; expiresAt: string }> {
  const input = parse(icuLimitInput, raw);
  await requirePermission(db, actor, ICU_DECIDE);
  await requireIcuPlacement(db, input.admissionId);
  const limitId = newId();
  const expiresAt = new Date(now.getTime() + ICU_LIMIT_TTL_MS);
  await inTx(db, async (tx) => {
    await tx.update(icuAlarmLimits).set({ supersededAt: now })
      .where(and(eq(icuAlarmLimits.admissionId, input.admissionId), eq(icuAlarmLimits.param, input.param), isNull(icuAlarmLimits.supersededAt)));
    await tx.insert(icuAlarmLimits).values({
      id: limitId, admissionId: input.admissionId, param: input.param, low: input.low ?? null, high: input.high ?? null,
      reason: input.reason ?? null, orderedBy: actor.id, orderedAt: now, expiresAt,
    });
  });
  return { limitId, expiresAt: expiresAt.toISOString() };
}

/** The nurse's tick: the same limit is now set on the bedside monitor. */
export async function confirmLimitOnMonitor(db: Db, actor: Actor, limitId: string, now: Date = new Date()): Promise<void> {
  await requirePermission(db, actor, ICU_CARE);
  const done = await db.update(icuAlarmLimits).set({ monitorSetBy: actor.id, monitorSetAt: now })
    .where(and(eq(icuAlarmLimits.id, limitId), isNull(icuAlarmLimits.monitorSetAt))).returning({ id: icuAlarmLimits.id });
  if (done.length === 0) {
    const exists = (await db.select({ id: icuAlarmLimits.id }).from(icuAlarmLimits).where(eq(icuAlarmLimits.id, limitId)))[0];
    if (exists === undefined) throw new IcuError("bad_input", { limitId });
  }
}

export type AckResult = { alarmId: string; state: "acknowledged"; ackBy: string; ackAt: string; rung: IcuAlarmRung; deviceSilenced: false };

/** Acknowledge: records the person and the instant; the ladder stops. The device is NEVER silenced (`deviceSilenced: false`). */
export async function acknowledgeAlarm(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<AckResult> {
  const input = parse(icuAckInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  return inTx(db, async (tx) => {
    const a = (await tx.select().from(icuAlarms).where(eq(icuAlarms.id, input.alarmId)).for("update"))[0];
    if (a === undefined) throw new IcuError("unknown_alarm");
    if (a.state !== "open") throw new IcuError("alarm_closed");
    await tx.update(icuAlarms).set({ state: "acknowledged", ackBy: actor.id, ackAt: now, ackNote: input.note ?? null }).where(eq(icuAlarms.id, a.id));
    await tx.insert(icuAlarmEvents).values({ id: newId(), alarmId: a.id, admissionId: a.admissionId, act: "acknowledged", rung: a.rung, actorId: actor.id, at: now });
    await appendEvent(tx, icuAlarmAcknowledged.make({ payload: { alarmId: a.id, admissionId: a.admissionId, rung: a.rung }, actor, correlationId: a.admissionId, occurredAt: now }));
    return { alarmId: a.id, state: "acknowledged" as const, ackBy: actor.id, ackAt: now.toISOString(), rung: a.rung as IcuAlarmRung, deviceSilenced: false as const };
  });
}

async function tell(tx: Tx, alarm: typeof icuAlarms.$inferSelect, rung: IcuAlarmRung, at: Date): Promise<void> {
  let people: string[] = [];
  if (rung === "station") people = await stationPeople(tx);
  else if (rung === "duty_doctor") {
    const a = (await tx.select({ consultantId: ipdAdmissions.consultantId, department: ipdAdmissions.department }).from(ipdAdmissions).where(eq(ipdAdmissions.id, alarm.admissionId)))[0];
    if (a !== undefined) people = await dutyDoctorsFor(tx, a, at);
  } else if (rung === "intensivist") people = await usersWithRole(tx, "intensivist");
  for (const userId of [...new Set(people)].sort()) {
    await raiseNoticeIn(tx, {
      userId, kind: "icu.alarm", title: `ICU alarm — ${alarm.message}`, body: `Not acknowledged; now with the ${rung.replace("_", " ")}`,
      refType: "icu_alarm", refId: alarm.id, sourceKey: `icu.alarm:${alarm.id}:${rung}`, at,
    });
  }
}

/** D5 — every open life-threatening alarm whose rung clock has run out climbs (catching up several rungs if the tick was late). */
export async function escalateAlarms(db: Db, now: Date): Promise<number> {
  const open = await db.select().from(icuAlarms).where(and(
    eq(icuAlarms.state, "open"), eq(icuAlarms.severity, "life_threatening"), ne(icuAlarms.rung, "intensivist"),
  ));
  let moved = 0;
  for (const candidate of open) {
    await inTx(db, async (tx) => {
      const a = (await tx.select().from(icuAlarms).where(eq(icuAlarms.id, candidate.id)).for("update"))[0];
      if (a === undefined || a.state !== "open") return;
      let rung = a.rung as IcuAlarmRung;
      let since = a.rungSince;
      while (rung !== "intensivist" && now.getTime() - since.getTime() >= ICU_RUNG_CLOCK_MS[rung]) {
        since = new Date(since.getTime() + ICU_RUNG_CLOCK_MS[rung]);
        rung = NEXT[rung];
        await tx.insert(icuAlarmEvents).values({ id: newId(), alarmId: a.id, admissionId: a.admissionId, act: "escalated", rung, actorId: null, at: since });
        await appendEvent(tx, icuAlarmEscalated.make({ payload: { alarmId: a.id, admissionId: a.admissionId, rung }, actor: ICU_SYSTEM, correlationId: a.admissionId, occurredAt: since }));
        await tell(tx, a, rung, since);
        moved += 1;
      }
      if (rung !== a.rung) await tx.update(icuAlarms).set({ rung, rungSince: since }).where(eq(icuAlarms.id, a.id));
    });
  }
  return moved;
}

/** D7 — open a gap for a gateway the kernel marked down (from its last sighting); close it at the sighting that ended it. */
export async function syncFeedGaps(db: Db, now: Date): Promise<{ opened: number; closed: number }> {
  const rows = await db.select({ gw: icuGateways, status: interfaces.status, lastSeenAt: interfaces.lastSeenAt })
    .from(icuGateways).innerJoin(interfaces, eq(interfaces.id, icuGateways.interfaceId)).where(eq(icuGateways.active, true));
  let opened = 0;
  let closed = 0;
  for (const r of rows) {
    if (r.lastSeenAt === null) continue;
    // The kernel's verdict (its 60-second sweep marks an interface down past its 300 s window) opens the gap; the
    // gateway's next heartbeat (`interface.restored`) ends it. The station greys from the heartbeat itself (`hallFeed`).
    const silent = r.status === "down";
    const open = (await db.select().from(icuFeedGaps).where(and(eq(icuFeedGaps.gatewayId, r.gw.id), isNull(icuFeedGaps.endedAt))))[0];
    if (silent && open === undefined) {
      const gapId = newId();
      const won = await db.insert(icuFeedGaps).values({ id: gapId, gatewayId: r.gw.id, startedAt: r.lastSeenAt }).onConflictDoNothing().returning({ id: icuFeedGaps.id });
      if (won.length > 0) {
        await inTx(db, (tx) => appendEvent(tx, icuFeedGapOpened.make({ payload: { gapId, gatewayId: r.gw.id, since: r.lastSeenAt!.toISOString() }, actor: ICU_SYSTEM, correlationId: r.gw.id, occurredAt: now })));
        opened += 1;
      }
    } else if (!silent && open !== undefined) {
      const done = await db.update(icuFeedGaps).set({ endedAt: r.lastSeenAt }).where(and(eq(icuFeedGaps.id, open.id), isNull(icuFeedGaps.endedAt))).returning({ id: icuFeedGaps.id });
      if (done.length > 0) {
        await inTx(db, (tx) => appendEvent(tx, icuFeedGapClosed.make({ payload: { gapId: open.id, gatewayId: r.gw.id, at: r.lastSeenAt!.toISOString() }, actor: ICU_SYSTEM, correlationId: r.gw.id, occurredAt: now })));
        closed += 1;
      }
    }
  }
  return { opened, closed };
}

