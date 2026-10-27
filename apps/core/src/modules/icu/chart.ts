import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import {
  ICU_PREFILL_WINDOW_MS, icuCorrectInput, icuManualHourInput, icuPrefillInput, icuSignInput, newId,
} from "@hmis/contracts";
import { icuChartHours, icuChartValues, icuNumerics } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { recordIcuChartVitals } from "../ipd";
import { inTx, median, parse, placementOf, requireIcuPlacement, requirePermission } from "./common";
import { IcuError } from "./errors";
import { icuHourSigned } from "./events";
import { hallFeed } from "./feed";
import { ICU_CARE, ICU_VIEW } from "./permissions";
import type { Actor, IcuChartHourView, IcuChartValueView, IcuChartView, IcuParam } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D4, D7) — THE HOURLY CHART. A chart hour starts on an IST hour mark. While the hall's feed is live the
 * hour is PRE-FILLED from the devices: per parameter, the median of the linked, non-technical values in the last 60 s
 * before the mark (a parameter with only technical readings — probe off — is written as that mark with NO value, never
 * as a real one). The pre-fill is a DRAFT: only the nurse's signature makes the hour the legal record, and the signature
 * is what writes the hour into the vitals record (`ipd.recordIcuChartVitals`, source `icu_chart`, no NEWS2 alert).
 *
 * The values are APPEND-ONLY. A correction is a new row that supersedes the old one and must carry a reason; the
 * original stays visible. While the feed is lost (D7) the hour is charted by hand: each manual value carries the instant
 * it HAPPENED and the instant it was ENTERED, so a back-filled hour says both.
 */

const HOUR = 3_600_000;
const IST_OFFSET = 5.5 * HOUR;
/** An IST hour mark (UTC :30). */
export const isIstHourMark = (d: Date): boolean => (d.getTime() + IST_OFFSET) % HOUR === 0;
export const istHourOf = (d: Date): Date => new Date(Math.floor((d.getTime() + IST_OFFSET) / HOUR) * HOUR - IST_OFFSET);

type HourRow = typeof icuChartHours.$inferSelect;
type ValueRow = typeof icuChartValues.$inferSelect;

function viewOf(h: HourRow, values: ValueRow[]): IcuChartHourView {
  const superseded = new Set(values.flatMap((v) => (v.supersedes === null ? [] : [v.supersedes])));
  return {
    id: h.id, hourStart: h.hourStart.toISOString(), state: h.state as "draft" | "signed", mode: h.mode as "device" | "manual",
    signedBy: h.signedBy, signedAt: h.signedAt?.toISOString() ?? null,
    values: values.map((v): IcuChartValueView => ({
      id: v.id, param: v.param as IcuParam, value: v.value, source: v.source as IcuChartValueView["source"], technical: v.technical,
      happenedAt: v.happenedAt.toISOString(), enteredAt: v.enteredAt.toISOString(), enteredBy: v.enteredBy, reason: v.reason,
      supersedes: v.supersedes, current: !superseded.has(v.id),
    })),
  };
}

async function hourView(db: Db | Tx, hourId: string): Promise<IcuChartHourView> {
  const h = (await (db as Db).select().from(icuChartHours).where(eq(icuChartHours.id, hourId)))[0];
  if (h === undefined) throw new IcuError("unknown_hour");
  const values = await (db as Db).select().from(icuChartValues).where(eq(icuChartValues.hourId, hourId)).orderBy(asc(icuChartValues.enteredAt), asc(icuChartValues.id));
  return viewOf(h, values);
}

function checkHour(hourStart: string, now: Date): Date {
  const h = new Date(hourStart);
  if (!isIstHourMark(h)) throw new IcuError("hour_not_mark");
  if (h.getTime() > now.getTime()) throw new IcuError("hour_in_future");
  return h;
}

export async function prefillHour(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<IcuChartHourView> {
  const input = parse(icuPrefillInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  const hour = checkHour(input.hourStart, now);
  await requireIcuPlacement(db, input.admissionId);
  const existing = (await db.select().from(icuChartHours).where(and(eq(icuChartHours.admissionId, input.admissionId), eq(icuChartHours.hourStart, hour))))[0];
  if (existing?.state === "signed") throw new IcuError("hour_signed");
  if (existing !== undefined) return hourView(db, existing.id);
  // Only ATTRIBUTED rows (an admission id = a confirmed link at the instant) — D3.
  const rows = await db.select({ param: icuNumerics.param, value: icuNumerics.value, technical: icuNumerics.technical })
    .from(icuNumerics).where(and(
      eq(icuNumerics.admissionId, input.admissionId), gte(icuNumerics.observedAt, new Date(hour.getTime() - ICU_PREFILL_WINDOW_MS)), lte(icuNumerics.observedAt, hour),
    ));
  const byParam = new Map<string, { real: number[]; technical: string[] }>();
  for (const r of rows) {
    const b = byParam.get(r.param) ?? { real: [], technical: [] };
    if (r.technical === null && r.value !== null) b.real.push(r.value);
    else if (r.technical !== null && r.technical !== "no_value") b.technical.push(r.technical);
    byParam.set(r.param, b);
  }
  const values: (typeof icuChartValues.$inferInsert)[] = [];
  for (const [param, b] of [...byParam].sort(([a], [z]) => a.localeCompare(z))) {
    if (b.real.length > 0) values.push({ id: newId(), hourId: "", param, value: Math.round(median(b.real) * 10) / 10, source: "device", technical: null, happenedAt: hour, enteredAt: now, enteredBy: null });
    else if (b.technical.length > 0) values.push({ id: newId(), hourId: "", param, value: null, source: "device", technical: b.technical.at(-1)!, happenedAt: hour, enteredAt: now, enteredBy: null });
  }
  if (values.length === 0) throw new IcuError("hour_empty");
  const hourId = newId();
  try {
    await inTx(db, async (tx) => {
      await tx.insert(icuChartHours).values({ id: hourId, admissionId: input.admissionId, hourStart: hour, state: "draft", mode: "device", createdAt: now });
      await tx.insert(icuChartValues).values(values.map((v) => ({ ...v, hourId })));
    });
  } catch (e) {
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
      const won = (await db.select().from(icuChartHours).where(and(eq(icuChartHours.admissionId, input.admissionId), eq(icuChartHours.hourStart, hour))))[0];
      if (won !== undefined) return hourView(db, won.id);
    }
    throw e;
  }
  return hourView(db, hourId);
}

const currentValues = (values: ValueRow[]): ValueRow[] => {
  const superseded = new Set(values.flatMap((v) => (v.supersedes === null ? [] : [v.supersedes])));
  return values.filter((v) => !superseded.has(v.id));
};

const int = (v: number | undefined): number | undefined => (v === undefined ? undefined : Math.round(v));

export async function signHour(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<IcuChartHourView> {
  const input = parse(icuSignInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  await inTx(db, async (tx) => {
    const h = (await tx.select().from(icuChartHours).where(eq(icuChartHours.id, input.hourId)).for("update"))[0];
    if (h === undefined) throw new IcuError("unknown_hour");
    if (h.state === "signed") throw new IcuError("hour_signed");
    const cur = currentValues(await tx.select().from(icuChartValues).where(eq(icuChartValues.hourId, h.id)));
    const v = new Map(cur.filter((x) => x.value !== null).map((x) => [x.param, x.value!] as const));
    let vitalsId: string | null = null;
    if (v.size > 0) {
      const sys = v.get("nibp_sys") ?? v.get("abp_sys");
      const dia = v.get("nibp_dia") ?? v.get("abp_dia");
      const values = {
        pulse: int(v.get("hr")), respRate: int(v.get("rr")), systolic: int(sys), diastolic: int(dia), spo2: int(v.get("spo2")), temperatureC: v.get("temp"),
      };
      const defined = Object.fromEntries(Object.entries(values).filter(([, x]) => x !== undefined));
      if (Object.keys(defined).length > 0) {
        vitalsId = (await recordIcuChartVitals(tx, actor, { admissionId: h.admissionId, hourId: h.id, observedAt: h.hourStart, values: defined }, now)).vitalsId;
      }
    }
    await tx.update(icuChartHours).set({ state: "signed", signedBy: actor.id, signedAt: now, vitalsId }).where(eq(icuChartHours.id, h.id));
    await appendEvent(tx, icuHourSigned.make({ payload: { hourId: h.id, admissionId: h.admissionId, mode: h.mode }, actor, correlationId: h.admissionId, occurredAt: now }));
  });
  return hourView(db, input.hourId);
}

export async function correctValue(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<IcuChartHourView> {
  const input = parse(icuCorrectInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  if (input.reason.trim() === "") throw new IcuError("reason_required");
  await inTx(db, async (tx) => {
    const h = (await tx.select().from(icuChartHours).where(eq(icuChartHours.id, input.hourId)).for("update"))[0];
    if (h === undefined) throw new IcuError("unknown_hour");
    const cur = currentValues(await tx.select().from(icuChartValues).where(and(eq(icuChartValues.hourId, h.id), eq(icuChartValues.param, input.param))))[0];
    if (cur === undefined) throw new IcuError("bad_input", { param: input.param, why: "no value to correct" });
    await tx.insert(icuChartValues).values({
      id: newId(), hourId: h.id, param: input.param, value: input.value, source: "correction", technical: null, happenedAt: cur.happenedAt,
      enteredAt: now, enteredBy: actor.id, supersedes: cur.id, reason: input.reason.trim(),
    });
  });
  return hourView(db, input.hourId);
}

/** D7 — an hour charted by hand while the hall's feed is lost (refused while the feed is live: the pre-fill is the path). */
export async function enterManualHour(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<IcuChartHourView> {
  const input = parse(icuManualHourInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  const p = await requireIcuPlacement(db, input.admissionId);
  // A live feed refuses hand charting outright, whatever the hour: the pre-fill is the path while the devices feed.
  if (!(await hallFeed(db, p.hallId, now)).grey) throw new IcuError("feed_live");
  const hour = checkHour(input.hourStart, now);
  const happenedAt = input.happenedAt !== undefined ? new Date(input.happenedAt) : hour;
  const entries = Object.entries(input.values).filter(([, v]) => v !== undefined) as [IcuParam, number][];
  if (entries.length === 0) throw new IcuError("hour_empty");
  const hourId = await inTx(db, async (tx) => {
    let h = (await tx.select().from(icuChartHours).where(and(eq(icuChartHours.admissionId, input.admissionId), eq(icuChartHours.hourStart, hour))).for("update"))[0];
    if (h?.state === "signed") throw new IcuError("hour_signed");
    if (h === undefined) {
      h = (await tx.insert(icuChartHours).values({ id: newId(), admissionId: input.admissionId, hourStart: hour, state: "draft", mode: "manual", createdAt: now }).returning())[0]!;
    }
    const have = new Set(currentValues(await tx.select().from(icuChartValues).where(eq(icuChartValues.hourId, h.id))).map((v) => v.param));
    const fresh = entries.filter(([p]) => !have.has(p));
    if (fresh.length > 0) {
      await tx.insert(icuChartValues).values(fresh.map(([param, value]) => ({
        id: newId(), hourId: h!.id, param, value, source: "manual", technical: null, happenedAt, enteredAt: now, enteredBy: actor.id,
      })));
    }
    return h.id;
  });
  return hourView(db, hourId);
}

/** The last 24 hours of chart hours (newest first), and whether the hall charts live or by hand now. */
export async function readChart(db: Db, actor: Actor, admissionId: string, now: Date = new Date()): Promise<IcuChartView> {
  await requirePermission(db, actor, ICU_VIEW);
  const p = await placementOf(db, admissionId);
  const feed = p === null ? null : await hallFeed(db, p.hallId, now);
  const hours = await db.select().from(icuChartHours).where(and(
    eq(icuChartHours.admissionId, admissionId), gte(icuChartHours.hourStart, new Date(now.getTime() - 24 * HOUR)),
  )).orderBy(desc(icuChartHours.hourStart));
  const values = hours.length === 0 ? [] : await db.select().from(icuChartValues)
    .where(inArray(icuChartValues.hourId, hours.map((h) => h.id))).orderBy(asc(icuChartValues.enteredAt), asc(icuChartValues.id));
  return {
    admissionId, mode: feed === null || feed.grey ? "manual" : "live",
    hours: hours.map((h) => viewOf(h, values.filter((v) => v.hourId === h.id))),
  };
}

/** Whether the hour just past is still unsigned (the tile's "hour due" mark). */
export async function hourDue(db: Db | Tx, admissionId: string, now: Date): Promise<boolean> {
  const last = istHourOf(now);
  const h = (await (db as Db).select({ state: icuChartHours.state }).from(icuChartHours)
    .where(and(eq(icuChartHours.admissionId, admissionId), eq(icuChartHours.hourStart, last), isNotNull(icuChartHours.signedAt))))[0];
  return h === undefined && now.getTime() - last.getTime() > 15 * 60_000;
}

