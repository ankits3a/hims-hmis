import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { hasPermission } from "../../kernel/auth/permissions";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { istDayString } from "../../kernel/approvals/cumulative";
import { LAB_CHASE_RUNGS, doctorDeskMoves, labCriticalCalls, labResults, orderItems, orders } from "../../kernel/db/schema";
import { doctorUnitsOn, prescriberPrint, resolverEnabled, teamMembers, whoIsOn } from "../roster";
import { resolvePatientId } from "../patients";
import { labCriticalOverdue } from "./events";
import type { LabChaseRung } from "../../kernel/db/schema";
import type { TeamMember } from "../roster";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E3.2 (#595, owner 2026-10-12 "go ahead") — **A LAB CRITICAL NOBODY READS BACK IS CHASED UP A LADDER.**
 *
 * Before this, a potassium of 6.8 opened a call (`results.ts` `openCriticalCall`) and then waited
 * for the technologist to remember to ring somebody; no person was pushed and no clock climbed.
 * This copies the radiology critical chaser (`modules/radiology/chasers.ts`) rather than waiting
 * for the escalation spine (E3.1):
 *
 *   · rung 0 — the ORDERING DOCTOR, alerted when the call opens (`startChase`);
 *   · rung 1 — the UNIT HEAD of the ordering doctor's unit, at 15 minutes;
 *   · rung 2 — the DUTY RMO (roster `casualty_mo`, radiology's DECIDED reading of "RMO"), at 30;
 *   · rung 3 — the HOD (`medical_superintendent` holders, radiology's DECIDED reading), at 45.
 *
 * It only climbs, stops at the HOD, and a read-back (`acknowledgeCritical`, the number must match)
 * stops it at any rung — the sweep reads `closed_at IS NULL` and the climb is a CAS on it.
 * Quick-entry criticals open no call (decision 0061), so they never reach this file.
 *
 * ═══ A VOICE, NOT TEETH (radiology's D7, unchanged) ═══
 *
 * The sweep writes the rung and one event. It never closes a call, never records an attempt and
 * never touches the result. The alerts consumer turns the event into a bell row per person, and the
 * phone push and the reach ladder relay that row — with no patient, no UHID and no value.
 *
 * ═══ A RUNG THAT NAMES NOBODY ═══
 *
 * The roster rungs name people only where a PUBLISHED roster answers (radiology's rule: with the
 * resolver off, `whoIsOn` returns every doctor, which is not a page). A rung that resolves to
 * nobody sends `recipientIds: []`, and the consumer falls back to `escalationRecipients(
 * "lab.critical_overdue")` — the duty managers unless the hospital configures a target. Silence is
 * never an outcome.
 *
 * ═══ A CRITICAL THE DOCTOR DESK MOVED (#929, after DD-1b #905) ═══
 *
 * A unit's head or senior resident can give an open critical to another member of the unit
 * (`doctor_desk_moves`); the Desk never edits this call (plan D-A). From then on the ladder chases the
 * HOLDER: the unit-head rung goes to the head of the unit the critical was moved in — the holder's
 * unit, and the one whose Desk shows the row (DECIDED: a resident rotating in from another unit is
 * chased up the unit that gave it to them, not their parent unit, whose Desk does not show it). Who
 * holds it is the Desk's own rule (`doctor-desk/owed.ts` `withMoves`, `criticalMoves`), read here from
 * the table because the Desk imports the lab and cannot be imported back: the newest move at or before
 * the sweep stands while the holder and the orderer are both still members of that unit and, for a
 * restricted test, the holder is the orderer or holds `orders.read.restricted` (DD11). Otherwise the
 * call climbs the ordering doctor's unit, as it always did. `owner_user_id` is not rewritten — a move
 * can be undone or outlived, so the sweep asks again each time. Rung 0 is spent when the call opens;
 * the holder's own alert is the Desk's move bell.
 */

/** Minutes per rung: the advisory 15-minute call target (`CRITICAL_CALL_TARGET_MINUTES`), now enforced by a voice. */
export const LAB_CHASE_RUNG_MINUTES = 15;

/** The system actor the sweep runs as. */
export const LAB_CHASE_ACTOR: Actor = { type: "system", id: "lab-critical-ladder" };

const TOP_RUNG = LAB_CHASE_RUNGS.length - 1;
/** How many calls one cycle will chase. A sweep that cannot finish is a sweep that never runs. */
const CHASE_LIMIT = 200;

/** Roster positions and the role the HOD rung reads (the radiology ladder's own, `CRITICAL_RUNG_ROLES`). */
const UNIT_HEAD_POSITION = "unit_head";
const DUTY_RMO_POSITION = "casualty_mo";
const HOD_ROLE = "medical_superintendent";

/** The rung the clock says a call opened at `openedAt` should be on at `now`. Pure. */
export function rungDue(openedAt: Date, now: Date): number {
  const minutes = Math.floor((now.getTime() - openedAt.getTime()) / 60_000);
  if (minutes < 0) return 0;
  return Math.min(TOP_RUNG, Math.floor(minutes / LAB_CHASE_RUNG_MINUTES));
}

async function publishedOrNull(
  exec: Db | Tx, q: { position: string; teamId?: string }, at: Date, env: NodeJS.ProcessEnv,
): Promise<string[] | null> {
  if (!resolverEnabled(env)) return null;
  try {
    const answer = await whoIsOn(exec, q, at, env);
    return answer.source === "published" && answer.userIds.length > 0 ? answer.userIds : null;
  } catch {
    return null; // a position the hospital has not seeded: the rung names nobody, the consumer falls back
  }
}

/** A unit's head at `at` from its members: whoever officiates as head, else the substantive head (`prescriberPrint`'s rule). */
function headsOf(members: readonly TeamMember[]): string[] {
  const heads = members.filter((m) => m.roleInTeam === "head");
  const acting = heads.filter((m) => m.officiating);
  return [...new Set((acting.length > 0 ? acting : heads.filter((m) => m.kind === "parent")).map((m) => m.userId))];
}

/**
 * Who a rung is, at `at`. The ordering doctor by id; the unit head by the published roster for the
 * doctor's unit, else the unit's head (officiating or substantive, `prescriberPrint`'s answer); the
 * duty RMO by the published roster only; the HOD by role. `[]` = nobody named.
 */
export async function chaseRecipients(
  exec: Db | Tx, rung: number, ownerUserId: string | null, at: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return rungRecipients(exec, rung, ownerUserId, null, at, env);
}

/** `chaseRecipients`, and for a call a Doctor Desk move gave away (#929) the unit head of `unitTeamId`, the unit that moved it. */
async function rungRecipients(
  exec: Db | Tx, rung: number, ownerUserId: string | null, unitTeamId: string | null, at: Date, env: NodeJS.ProcessEnv,
): Promise<string[]> {
  switch (LAB_CHASE_RUNGS[rung]) {
    case "ordering_doctor":
      return ownerUserId === null ? [] : [ownerUserId];
    case "unit_head": {
      if (unitTeamId !== null) {
        const rostered = await publishedOrNull(exec, { position: UNIT_HEAD_POSITION, teamId: unitTeamId }, at, env);
        return rostered ?? headsOf(await teamMembers(exec, unitTeamId, at));
      }
      if (ownerUserId === null) return [];
      const istDate = istDayString(at);
      const unit = (await doctorUnitsOn(exec, istDate)).find((u) => u.userId === ownerUserId);
      if (unit === undefined) return [];
      const rostered = await publishedOrNull(exec, { position: UNIT_HEAD_POSITION, teamId: unit.teamId }, at, env);
      if (rostered !== null) return rostered;
      const head = (await prescriberPrint(exec, { userId: ownerUserId, code: null }, { istDate, opdDepartmentId: null })).headUserId;
      return head === null ? [] : [head];
    }
    case "duty_rmo":
      return (await publishedOrNull(exec, { position: DUTY_RMO_POSITION }, at, env)) ?? [];
    case "hod":
      return usersHoldingRole(exec as Tx, HOD_ROLE);
    default:
      return [];
  }
}

const MOVED_ROW = "lab_critical:";

/**
 * #929 — the calls a standing Doctor Desk move has given to another member, by the Desk's rule (see
 * the header): call id → the unit that moved it, which its ladder now climbs. Unmoved calls are absent.
 */
async function movedUnits(
  exec: Db | Tx, calls: readonly { id: string; ownerUserId: string | null; restricted: boolean }[], at: Date,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const owned = calls.filter((c) => c.ownerUserId !== null);
  if (owned.length === 0) return out;
  const moves = await (exec as Db)
    .select({ rowKey: doctorDeskMoves.rowKey, teamId: doctorDeskMoves.teamId, toUserId: doctorDeskMoves.toUserId })
    .from(doctorDeskMoves)
    .where(and(inArray(doctorDeskMoves.rowKey, owned.map((c) => `${MOVED_ROW}${c.id}`)), lte(doctorDeskMoves.createdAt, at)))
    .orderBy(desc(doctorDeskMoves.createdAt));
  const newest = new Map<string, (typeof moves)[number]>();
  for (const m of moves) if (!newest.has(m.rowKey)) newest.set(m.rowKey, m);
  const units = new Map<string, Set<string>>();
  for (const c of owned) {
    const m = newest.get(`${MOVED_ROW}${c.id}`);
    if (m === undefined) continue;
    let members = units.get(m.teamId);
    if (members === undefined) {
      members = new Set((await teamMembers(exec, m.teamId, at)).map((t) => t.userId));
      units.set(m.teamId, members);
    }
    if (!members.has(m.toUserId) || !members.has(c.ownerUserId!)) continue;
    if (c.restricted && m.toUserId !== c.ownerUserId
      && !(await hasPermission(exec as Db, m.toUserId, "orders.read.restricted", "hospital").catch(() => false))) continue;
    out.set(c.id, m.teamId);
  }
  return out;
}

function overdueEvent(
  call: { id: string; resultId: string; openedAt: Date }, rung: number, recipientIds: string[], now: Date,
  envelope: { actor: Actor; patientId?: string; correlationId?: string },
) {
  return labCriticalOverdue.make({
    actor: envelope.actor,
    patientId: envelope.patientId,
    correlationId: envelope.correlationId,
    payload: {
      callId: call.id, resultId: call.resultId, rung: LAB_CHASE_RUNGS[rung] as LabChaseRung,
      minutesOpen: Math.max(0, Math.floor((now.getTime() - call.openedAt.getTime()) / 60_000)),
      recipientIds,
    },
  });
}

/**
 * Rung 0, inside the transaction that opens the call: the call gets its owner and rung, and the
 * ordering doctor's alert is evented in the same commit — a call that exists is a call being chased.
 */
export async function startChase(
  tx: Tx, actor: Actor, call: { id: string; resultId: string; openedAt: Date; orderId: string; patientId: string },
): Promise<void> {
  const [order] = await tx.select({ clinician: orders.orderingClinicianId }).from(orders).where(eq(orders.id, call.orderId));
  const ownerUserId = order?.clinician ?? null;
  await tx.update(labCriticalCalls)
    .set({ ownerUserId, ladderRung: 0, lastChasedAt: call.openedAt })
    .where(eq(labCriticalCalls.id, call.id));
  await appendEvent(tx, overdueEvent(call, 0, ownerUserId === null ? [] : [ownerUserId], call.openedAt, {
    actor, patientId: call.patientId, correlationId: call.orderId,
  }));
}

export type LabChaseResult = { chased: { callId: string; rung: LabChaseRung; recipients: number }[] };

/**
 * ═══ THE SWEEP (every minute) ═══
 *
 * Every OPEN call on the ladder below the HOD whose clock has passed its next rung. It jumps to the
 * rung the clock says (a worker that was down for 40 minutes alerts the duty RMO, not the unit head
 * and then the duty RMO a minute later), and the climb is a CAS on (rung, `closed_at IS NULL`):
 * two overlapping cycles alert once, and a read-back that lands first wins. A call a Doctor Desk
 * move gave to another member climbs the unit that moved it (#929).
 */
export async function sweepLabCriticalLadder(
  db: Db, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env,
): Promise<LabChaseResult> {
  const open = await db
    .select({
      id: labCriticalCalls.id, resultId: labCriticalCalls.resultId, openedAt: labCriticalCalls.openedAt,
      ladderRung: labCriticalCalls.ladderRung, ownerUserId: labCriticalCalls.ownerUserId,
      orderId: orders.id, patientId: orders.patientId, restricted: orderItems.restricted,
    })
    .from(labCriticalCalls)
    .innerJoin(labResults, eq(labResults.id, labCriticalCalls.resultId))
    .innerJoin(orderItems, eq(orderItems.id, labResults.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      isNull(labCriticalCalls.closedAt),
      isNotNull(labCriticalCalls.ladderRung),
      lt(labCriticalCalls.ladderRung, TOP_RUNG),
    ))
    .orderBy(asc(labCriticalCalls.openedAt))
    .limit(CHASE_LIMIT);

  const due = open.map((call) => ({ call, to: rungDue(call.openedAt, now) })).filter(({ call, to }) => to > call.ladderRung!);
  /* A holder that cannot be worked out is no reason to go silent: the call climbs the orderer's unit. */
  const moved = await movedUnits(db, due.map(({ call }) => call), now).catch(() => new Map<string, string>());
  const chased: LabChaseResult["chased"] = [];
  for (const { call, to } of due) {
    const from = call.ladderRung!;
    const recipientIds = await rungRecipients(db, to, call.ownerUserId, moved.get(call.id) ?? null, now, env);
    const patientId = (await resolvePatientId(db, call.patientId)) ?? call.patientId;

    const won = await withTx(db, async (tx) => {
      const moved = await tx.update(labCriticalCalls)
        .set({ ladderRung: sql`greatest(${labCriticalCalls.ladderRung}, ${to})`, lastChasedAt: now })
        .where(and(
          eq(labCriticalCalls.id, call.id),
          eq(labCriticalCalls.ladderRung, from),
          isNull(labCriticalCalls.closedAt),
        ))
        .returning({ id: labCriticalCalls.id });
      if (moved.length === 0) return false;
      await appendEvent(tx, overdueEvent(call, to, recipientIds, now, {
        actor: LAB_CHASE_ACTOR, patientId, correlationId: call.orderId,
      }));
      return true;
    });
    if (won) chased.push({ callId: call.id, rung: LAB_CHASE_RUNGS[to]!, recipients: recipientIds.length });
  }
  return { chased };
}

/* ═══════════════════════════════ G5 — how long a read-back takes ═══════════════════════════════ */

export type ReadbackWeek = { week: string; count: number; medianMin: number; p95Min: number };

/**
 * E3.2 / goal G5 (decision 0064) — per ISO week (IST) of `opened_at`, how many critical calls were
 * READ BACK and how long that took: the median and the 95th percentile of `closed_at − opened_at`,
 * in minutes, to one decimal. Open calls are not counted (they have no answer yet). READ-ONLY: one
 * SELECT, so `scripts/g5-critical-readback.ts` can run it against production in a read-only transaction.
 */
export async function criticalReadbackByWeek(exec: Db | Tx, opts: { since?: Date } = {}): Promise<ReadbackWeek[]> {
  const since = opts.since ?? null;
  const result = await (exec as Db).execute<{ week: string; n: number; median: string; p95: string }>(sql`
    select to_char(opened_at at time zone 'Asia/Kolkata', 'IYYY-"W"IW') as week,
           count(*)::int as n,
           percentile_cont(0.5) within group (order by extract(epoch from closed_at - opened_at) / 60.0) as median,
           percentile_cont(0.95) within group (order by extract(epoch from closed_at - opened_at) / 60.0) as p95
      from lab_critical_calls
     where closed_at is not null
       and (${since}::timestamptz is null or opened_at >= ${since}::timestamptz)
     group by 1
     order by 1`);
  const oneDecimal = (v: string | number): number => Math.round(Number(v) * 10) / 10;
  return result.rows.map((r) => ({ week: r.week, count: Number(r.n), medianMin: oneDecimal(r.median), p95Min: oneDecimal(r.p95) }));
}
