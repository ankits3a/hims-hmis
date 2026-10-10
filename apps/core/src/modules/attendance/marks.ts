import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { attAppMarks, attStaff } from "../../kernel/db/schema";
import { attendanceAppMarked } from "./events";
import { istDate, istTime } from "./ist";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ "MARK ATTENDANCE" FROM THE STAFF APP — A BACKUP TO THE MACHINE (owner 2026-10-10, decision 0061) ═══
 *
 * The phone reads its position ONCE, in the foreground, and sends it with the tap. The server turns
 * that reading into one word and a whole number of metres, and FORGETS THE READING: no column, event,
 * log line or error ever holds a latitude or longitude. The centre and radius are server settings
 * (`ATTENDANCE_SITE_*`), so they change with no app build.
 *
 *   inside       within the radius (a distance that ROUNDS to the radius or less)
 *   outside      beyond it
 *   not_shared   no reading — permission refused, or the phone could not get one
 *   doubtful     the phone said the reading was mocked (Android's `mocked`), wherever it points
 *
 * OPTION B (a money ruling): a mark is EVIDENCE for the Attendance Committee. It never touches
 * `att_punches` or `att_days`, is never sent to bioattend, and never changes a day's word.
 */
export const MARK_PLACES = ["inside", "outside", "not_shared", "doubtful"] as const;
export type MarkPlace = (typeof MARK_PLACES)[number];
export type MarkKind = "in" | "out";
export type Site = { lat: number; lng: number; radiusM: number };
export type Reading = { latitude: number; longitude: number; mocked: boolean };

/** DECIDED: at most this many marks a person a day (in, out, in, out, …) — a backup, not a punch clock. */
export const MAX_MARKS_PER_DAY = 6;
/** DECIDED: a second tap this soon after the last returns the last mark — a double tap is not "out". */
export const REPEAT_WINDOW_MS = 60_000;

/** The IUGG mean Earth radius. Great-circle (haversine) distance in metres, unrounded. */
const EARTH_M = 6_371_008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The whole judgement, pure: a reading (or none) against the site. */
export function placeOf(reading: Reading | null, site: Site): { place: MarkPlace; distanceM: number | null } {
  if (reading === null) return { place: "not_shared", distanceM: null };
  const distanceM = Math.round(metresBetween(site, { lat: reading.latitude, lng: reading.longitude }));
  if (reading.mocked) return { place: "doubtful", distanceM };
  return { place: distanceM <= site.radiusM ? "inside" : "outside", distanceM };
}

export class MarkError extends Error {
  constructor(readonly code: "not_linked" | "too_many_marks") { super(code); }
}

/** What the person themself sees of a mark: words, no time, no metres (decision 0060's self rule). */
export type SelfMarkView = { date: string; kind: MarkKind; place: MarkPlace };
/** What a manager sees: beside the machine's punches, with the time and the metres. */
export type MarkView = { date: string; time: string; kind: MarkKind; place: MarkPlace; distanceM: number | null };

const asSelf = (r: { day: string; kind: string; place: string }): SelfMarkView => ({ date: r.day, kind: r.kind as MarkKind, place: r.place as MarkPlace });
const asFull = (r: { day: string; markedAt: Date; kind: string; place: string; distanceM: number | null }): MarkView => ({
  date: r.day, time: istTime(r.markedAt), kind: r.kind as MarkKind, place: r.place as MarkPlace, distanceM: r.distanceM,
});

/**
 * Save one mark for a signed-in, LINKED person. The kind is the server's: "in" when the person has an
 * even number of marks today, "out" when odd. One person at a time (advisory lock), so two taps
 * cannot both be "in".
 */
export async function markAttendance(db: Db, userId: string, reading: Reading | null, site: Site, now: Date): Promise<{ created: boolean; mark: SelfMarkView }> {
  const { place, distanceM } = placeOf(reading, site);
  const day = istDate(now);
  return withTx(db, async (tx) => {
    const person = (await tx.select({ pin: attStaff.pin }).from(attStaff).where(eq(attStaff.userId, userId)))[0];
    if (person === undefined) throw new MarkError("not_linked");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`att-mark:${userId}`}))`);
    const todays = await tx.select().from(attAppMarks).where(and(eq(attAppMarks.userId, userId), eq(attAppMarks.day, day))).orderBy(desc(attAppMarks.markedAt));
    const last = todays[0];
    if (last !== undefined && now.getTime() - last.markedAt.getTime() < REPEAT_WINDOW_MS) return { created: false, mark: asSelf(last) };
    if (todays.length >= MAX_MARKS_PER_DAY) throw new MarkError("too_many_marks");
    const kind: MarkKind = todays.length % 2 === 0 ? "in" : "out";
    const row = (await tx.insert(attAppMarks).values({ id: newId(), userId, pin: person.pin, day, markedAt: now, kind, place, distanceM }).returning())[0]!;
    await appendEvent(tx, attendanceAppMarked.make({
      actor: { type: "user", id: userId }, occurredAt: now,
      payload: { markId: row.id, userId, pin: person.pin, day, kind, place, distanceM },
    }));
    return { created: true, mark: asSelf(row) };
  });
}

/** A person's own marks in a range, oldest first — words only. */
export async function selfMarks(db: Db, userId: string, from: string, to: string): Promise<SelfMarkView[]> {
  const rows = await db.select({ day: attAppMarks.day, kind: attAppMarks.kind, place: attAppMarks.place }).from(attAppMarks)
    .where(and(eq(attAppMarks.userId, userId), gte(attAppMarks.day, from), lte(attAppMarks.day, to))).orderBy(asc(attAppMarks.markedAt));
  return rows.map(asSelf);
}

/** Marks of a set of pins in a range, oldest first, keyed by pin — for a manager's view. */
export async function marksOfPins(db: Db, pins: readonly string[], from: string, to: string): Promise<Map<string, MarkView[]>> {
  const out = new Map<string, MarkView[]>(pins.map((p) => [p, []]));
  if (pins.length === 0) return out;
  const rows = await db.select({ pin: attAppMarks.pin, day: attAppMarks.day, markedAt: attAppMarks.markedAt, kind: attAppMarks.kind, place: attAppMarks.place, distanceM: attAppMarks.distanceM })
    .from(attAppMarks).where(and(inArray(attAppMarks.pin, [...pins]), gte(attAppMarks.day, from), lte(attAppMarks.day, to))).orderBy(asc(attAppMarks.markedAt));
  for (const r of rows) out.get(r.pin)?.push(asFull(r));
  return out;
}

/** The newest mark today of each pin that has one — the "beside the machine" tag on a today list. */
export async function latestMarks(db: Db, today: string, pins?: readonly string[]): Promise<Map<string, MarkView>> {
  if (pins !== undefined && pins.length === 0) return new Map();
  const rows = await db.select({ pin: attAppMarks.pin, day: attAppMarks.day, markedAt: attAppMarks.markedAt, kind: attAppMarks.kind, place: attAppMarks.place, distanceM: attAppMarks.distanceM })
    .from(attAppMarks).where(and(eq(attAppMarks.day, today), ...(pins === undefined ? [] : [inArray(attAppMarks.pin, [...pins])]))).orderBy(asc(attAppMarks.markedAt));
  const out = new Map<string, MarkView>();
  for (const r of rows) out.set(r.pin, asFull(r));
  return out;
}
