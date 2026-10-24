import { and, eq, gte, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { raiseNotice } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { alerts, ipdAdmissions, ipdRounds } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { absentUserIds, addIstDays, holidaysBetween, istMinutesOfInstant, istWeekday } from "../roster";
import { lockAdmission } from "./admission-core";
import { IPD_PLACED_STATES } from "./admission-place";
import { userNames } from "./admissions";
import { roundsCoverSet } from "./rounds-events";
import { coveringConsultantFor, unitHeadFor, unitsOn } from "./rounds-team";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * E4.2 (#734) — THE ROUNDS CLOCK (spec §4.5A edge cases). Nothing HAPPENS at 08:00 or 14:00 — the clock reaches it — so a
 * sweep raises what is due. It rides the worker's `sweepStaffNotices` minute tick (no job of its own: "a name in the
 * scheduler census per sweep, not per sentence", and no new pool client). Every instant is built from `istDayWindow`
 * (`kernel/approvals/cumulative`); there is no hand-written offset here.
 *
 * 08:00 IST — THE COVER HAND-OVER. A consultant on APPROVED leave at 08:00 (roster `absentUserIds`) has their inpatients
 *   covered by their unit's head (officiating head first — `coveringConsultantFor`): `ipd_admissions.covering_for` is set
 *   (so the covering consultant's visit bills `visit`, not `cross_visit`, and they may declare fit and sign the summary)
 *   and the covering consultant gets ONE bell row naming whose patients and how many. A consultant back from leave has
 *   it cleared at the next 08:00. Runs every tick 08:00–11:59 and writes only what differs.
 * 14:00 IST, MONDAY TO SATURDAY (DECIDED: the Indian hospital working week) — a patient in a bed since before today with
 *   no consultant bedside round today: ONE nudge to the responsible consultant (covering, else admitting) per day, then at
 *   16:00 ONE to their unit head. Counts and staff names only — no patient name (GC6). Nothing after 20:00.
 */
export const IPD_ROUND_NUDGE_KIND = "ipd_round_nudge";
export const IPD_ROUND_NUDGE_HEAD_KIND = "ipd_round_nudge_head";
export const IPD_COVER_KIND = "ipd_cover_today";
export const IPD_ROUNDS_REF_TYPE = "ipd_rounds";
const CLOCK_ACTOR: Actor = { type: "system", id: "ipd-rounds-clock" };

/** The clock's instants, as minutes past IST midnight (roster `istMinutesOfInstant` — the shared IST clock). */
export const COVER_FROM = 8 * 60;
export const COVER_UNTIL = 12 * 60;
export const NUDGE_FROM = 14 * 60;
export const NUDGE_HEAD_FROM = 16 * 60;
export const NUDGE_UNTIL = 20 * 60;
/** A resident's draft waiting this long for its co-sign nudges the consultant who may co-sign (once per draft). */
export const STRANDED_DRAFT_HOURS = 24;

export async function sweepIpdRoundsClock(db: Db, now: Date): Promise<{ covers: number; nudges: number; drafts: number }> {
  const minute = istMinutesOfInstant(now);
  const date = istDayString(now);
  let covers = 0;
  let nudges = 0;
  if (minute >= COVER_FROM && minute < COVER_UNTIL) covers = await applyCovers(db, now, now);
  // Mon–Sat, and never on a declared roster holiday (review of 72f10b68).
  if (minute >= NUDGE_FROM && minute < NUDGE_UNTIL && istWeekday(date) !== 0 && (await holidaysBetween(db, date, addIstDays(date, 1))).length === 0) {
    nudges = await nudgeUnrounded(db, now, minute >= NUDGE_HEAD_FROM);
  }
  const drafts = minute >= NUDGE_FROM && minute < NUDGE_UNTIL ? await nudgeStrandedDrafts(db, now) : 0;
  return { covers, nudges, drafts };
}

/** Sets or clears `covering_for` on every open admission by the roster at `at` (08:00). Returns rows changed. */
export async function applyCovers(db: Db, at: Date, now: Date): Promise<number> {
  const date = istDayString(at);
  // Review of 72f10b68: narrowed in SQL — only admissions whose consultant is away now or that carry a cover to clear.
  const away = new Set(await absentUserIds(db, at, new Date(at.getTime() + 1)));
  const who = [isNotNull(ipdAdmissions.coveringFor), ...(away.size > 0 ? [inArray(ipdAdmissions.consultantId, [...away])] : [])];
  const open = await db.select({ id: ipdAdmissions.id, consultantId: ipdAdmissions.consultantId, coveringFor: ipdAdmissions.coveringFor })
    .from(ipdAdmissions).where(and(inArray(ipdAdmissions.state, [...IPD_PLACED_STATES]), or(...who)));
  if (open.length === 0) return 0;
  const units = away.size === 0 ? new Map<string, string>() : await unitsOn(db, date);
  const coverOf = new Map<string, string | null>();
  for (const cid of new Set(open.map((a) => a.consultantId))) {
    coverOf.set(cid, away.has(cid) ? await coveringConsultantFor(db, cid, at, units) : null);
  }
  const changed = open.filter((a) => (coverOf.get(a.consultantId) ?? null) !== a.coveringFor);
  let n = 0;
  const newlyCovered = new Map<string, Map<string, number>>(); // cover → consultant → count
  for (const row of changed) {
    const done = await withTx(db, async (tx) => {
      const a = await lockAdmission(tx, row.id);
      if (!(IPD_PLACED_STATES as readonly string[]).includes(a.state)) return false;
      const cover = coverOf.get(a.consultantId) ?? null;
      if (cover === a.coveringFor) return false;
      await tx.update(ipdAdmissions).set({ coveringFor: cover, updatedAt: now }).where(eq(ipdAdmissions.id, a.id));
      await appendEvent(tx, roundsCoverSet.make({
        payload: { admissionId: a.id, consultantId: a.consultantId, coveringId: cover, istDate: date, provenance: "system" },
        actor: CLOCK_ACTOR, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: now,
      }));
      if (cover !== null) {
        const m = newlyCovered.get(cover) ?? new Map<string, number>();
        m.set(a.consultantId, (m.get(a.consultantId) ?? 0) + 1);
        newlyCovered.set(cover, m);
      }
      return true;
    });
    if (done) n += 1;
  }
  const names = await userNames(db, [...newlyCovered.values()].flatMap((m) => [...m.keys()]));
  for (const [cover, byConsultant] of newlyCovered) {
    for (const [cid, count] of byConsultant) {
      await raiseNotice(db, {
        userId: cover, kind: IPD_COVER_KIND, refType: IPD_ROUNDS_REF_TYPE, refId: cid,
        title: "Covering inpatients today",
        body: `You cover ${count === 1 ? "1 inpatient" : `${String(count)} inpatients`} of ${names.get(cid) ?? "a colleague"} today. Open Rounds.`,
        sourceKey: `ipd-cover:${cid}:${date}`, at: now,
      });
    }
  }
  return n;
}

/** One nudge per responsible consultant per IST day; with `heads`, one per (unit head, consultant) per day. */
export async function nudgeUnrounded(db: Db, now: Date, heads: boolean): Promise<number> {
  const { start, end } = istDayWindow(now);
  const date = istDayString(now);
  const inBed = await db.select({ id: ipdAdmissions.id, consultantId: ipdAdmissions.consultantId, coveringFor: ipdAdmissions.coveringFor })
    .from(ipdAdmissions)
    .where(and(inArray(ipdAdmissions.state, ["admitted", "transferring"]), isNotNull(ipdAdmissions.admittedAt), lt(ipdAdmissions.admittedAt, start)));
  if (inBed.length === 0) return 0;
  const seen = await db.select({ admissionId: ipdRounds.admissionId, authorId: ipdRounds.authorId }).from(ipdRounds).where(and(
    inArray(ipdRounds.admissionId, inBed.map((a) => a.id)), gte(ipdRounds.seenAt, start), lt(ipdRounds.seenAt, end),
    eq(ipdRounds.authorKind, "consultant"), eq(ipdRounds.mode, "bedside"), eq(ipdRounds.status, "signed"),
  ));
  const rounded = new Set(seen.map((s) => s.admissionId));
  const owing = new Map<string, number>();
  for (const a of inBed) {
    if (rounded.has(a.id)) continue;
    const who = a.coveringFor ?? a.consultantId;
    owing.set(who, (owing.get(who) ?? 0) + 1);
  }
  if (owing.size === 0) return 0;
  const keyOf = (uid: string) => `ipd-round-nudge:${uid}:${date}`;
  const headKeyOf = (uid: string) => `ipd-round-nudge-head:${uid}:${date}`;
  const wanted = [...owing.keys()].flatMap((u) => [keyOf(u), ...(heads ? [headKeyOf(u)] : [])]);
  const already = new Set((await db.select({ k: alerts.sourceEventId }).from(alerts).where(inArray(alerts.sourceEventId, wanted))).map((r) => r.k));
  const units = heads ? await unitsOn(db, date) : new Map<string, string>();
  const names = heads ? await userNames(db, [...owing.keys()]) : new Map<string, string>();
  let raised = 0;
  for (const [uid, count] of owing) {
    const many = count === 1 ? "1 inpatient has" : `${String(count)} inpatients have`;
    if (!already.has(keyOf(uid))) {
      if (await raiseNotice(db, {
        userId: uid, kind: IPD_ROUND_NUDGE_KIND, refType: IPD_ROUNDS_REF_TYPE, refId: uid,
        title: "Ward round pending", body: `${many} no consultant round today. Open Rounds.`, sourceKey: keyOf(uid), at: now,
      })) raised += 1;
    }
    if (heads && !already.has(headKeyOf(uid))) {
      const head = await unitHeadFor(db, uid, now, units);
      if (head !== null && await raiseNotice(db, {
        userId: head, kind: IPD_ROUND_NUDGE_HEAD_KIND, refType: IPD_ROUNDS_REF_TYPE, refId: uid,
        title: "Unit round pending", body: `${names.get(uid) ?? "A consultant"}: ${many} no consultant round today.`,
        sourceKey: headKeyOf(uid), at: now,
      })) raised += 1;
    }
  }
  return raised;
}

/**
 * Review of 72f10b68 (DECIDED): discharge never waits on a co-sign (no detention), so a resident's draft can outlive the
 * stay. A draft waiting over 24 h — in a bed or ended within the co-sign window — tells the treating consultant (covering,
 * else admitting) ONCE, by count. The co-sign queue lists it until it is signed.
 */
export const IPD_DRAFT_NUDGE_KIND = "ipd_round_draft_waiting";

export async function nudgeStrandedDrafts(db: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - STRANDED_DRAFT_HOURS * 3_600_000);
  const drafts = await db.select({ id: ipdRounds.id, admissionId: ipdRounds.admissionId }).from(ipdRounds)
    .where(and(eq(ipdRounds.status, "awaiting_cosign"), lte(ipdRounds.seenAt, before)));
  if (drafts.length === 0) return 0;
  const keys = drafts.map((d) => `ipd-draft-waiting:${d.id}`);
  const already = new Set((await db.select({ k: alerts.sourceEventId }).from(alerts).where(inArray(alerts.sourceEventId, keys))).map((r) => r.k));
  const fresh = drafts.filter((d) => !already.has(`ipd-draft-waiting:${d.id}`));
  if (fresh.length === 0) return 0;
  const adm = new Map((await db.select({ id: ipdAdmissions.id, consultantId: ipdAdmissions.consultantId, coveringFor: ipdAdmissions.coveringFor })
    .from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...new Set(fresh.map((d) => d.admissionId))]))).map((a) => [a.id, a] as const));
  let raised = 0;
  for (const d of fresh) {
    const a = adm.get(d.admissionId);
    if (a === undefined) continue;
    if (await raiseNotice(db, {
      userId: a.coveringFor ?? a.consultantId, kind: IPD_DRAFT_NUDGE_KIND, refType: IPD_ROUNDS_REF_TYPE, refId: d.id,
      title: "Round waiting for co-sign", body: "A resident's round has waited over a day. Open Rounds.", sourceKey: `ipd-draft-waiting:${d.id}`, at: now,
    })) raised += 1;
  }
  return raised;
}
