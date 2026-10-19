import type { Actor, WireDayLine, WireScheduleRow, WireTeamMember, WireTower } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { doctorDayLines } from "../opd";
import { dutiesOf, myDuties } from "../roster";
import { deskScope } from "./scope";
import { waitingOn } from "./waiting-on";
import { owedByUnit, withNudgedBy } from "./owed";
import { briefsWaiting, loginFacts, maybeBuildLoginBrief, towerBrief } from "./briefs";
import { runsFor } from "./agent-runs";
import type { DoctorDayLine } from "../opd";
import type { Db } from "../../kernel/db/client";

/**
 * DD-0.1 / 0.4 / 0.5 — THE TOWER, OPD-DAY MODE: one aggregated read (plan §6 "speed: Tower is one
 * aggregated read; no LLM on a tap").
 *
 * What the board draws and DD-0 cannot source is ABSENT, never a zero (plan §3.0): inpatient tiles,
 * bed dots, "Last 7 Days", teaching and OT rows in the schedule. The OPD tiles appear only on a day
 * the doctor has an OPD session (`mode: "opd_day"`); a zero booked on a ward day would be a wrong
 * number that looks right.
 *
 * Nothing here carries money (decision 0058): the OPD line comes from `doctorDayLines`, which
 * selects no fee column at all.
 */
const toWireLine = (l: DoctorDayLine): WireDayLine => ({
  userId: l.userId, name: l.displayName, session: l.session, booked: l.booked, seen: l.seen,
  waiting: l.waiting, inConsult: l.inConsult, longestWaitMinutes: l.longestWaitMinutes,
});

async function onDutyUntil(db: Db, userId: string, at: Date): Promise<string | null> {
  try {
    const live = (await dutiesOf(db, userId, at, new Date(at.getTime() + 60_000)))
      .filter((d) => d.kind !== "off" && d.startsAt <= at && d.endsAt > at);
    if (live.length === 0) return null;
    return new Date(Math.max(...live.map((d) => d.endsAt.getTime()))).toISOString();
  } catch { return null; }
}

async function scheduleOf(db: Db, actor: Actor, at: Date, istDate: string, mine: DoctorDayLine | null): Promise<WireScheduleRow[]> {
  const rows: WireScheduleRow[] = [];
  try {
    const m = await myDuties(db, actor, at);
    for (const d of m.duties) {
      if (d.istDate !== istDate || d.kind === "off") continue;
      rows.push({
        kind: "duty", startsAt: d.startsAt.toISOString(), endsAt: d.endsAt.toISOString(), night: d.night,
        positionKey: d.positionKey, mode: d.mode, dutyKind: d.kind, activities: d.activities,
      });
    }
  } catch { /* no roster grant or no roster: the schedule shows the OPD line alone */ }
  if (mine !== null && mine.session !== "none") rows.push({ kind: "opd", session: mine.session, booked: mine.booked, waiting: mine.waiting });
  return rows;
}

export async function towerView(db: Db, actor: Actor, at: Date): Promise<WireTower> {
  const scope = await deskScope(db, actor, at);
  const memberIds = scope.members.map((m) => m.userId);
  const lines = await doctorDayLines(db, [...new Set([actor.id, ...memberIds])], scope.istDate, at).catch(() => [] as DoctorDayLine[]);
  const mine = lines.find((l) => l.userId === actor.id) ?? null;
  const attention = await waitingOn(db, actor, at, scope.istDate);

  // The login brief is built BEFORE the read that shows it, inside one transaction with the read stamp.
  if (actor.type === "user") {
    await withTx(db, (tx) => maybeBuildLoginBrief(tx, actor.id, at, (from) => loginFacts(attention, mine, from, at)));
  }

  const owed = scope.unit === null ? [] : await owedByUnit(db, scope.members, at).catch(() => []);
  const clocks = await withNudgedBy(db, owed, actor.id);
  const holds = new Map<string, number>();
  for (const r of owed) holds.set(r.holder.userId, (holds.get(r.holder.userId) ?? 0) + 1);
  const team: WireTeamMember[] = await Promise.all(scope.members.map(async (m) => ({
    userId: m.userId, name: m.name, role: m.roleInTeam, officiating: m.officiating,
    onDutyUntil: await onDutyUntil(db, m.userId, at), holds: holds.get(m.userId) ?? 0,
  })));

  const opdDay = mine !== null && mine.session !== "none";
  const tabCounts = { all: attention.length, critical: 0, change: 0, new: 0, pending: 0 };
  for (const r of attention) tabCounts[r.tab] += 1;

  return {
    at: at.toISOString(),
    istDate: scope.istDate,
    you: { userId: actor.id, name: scope.name, grade: scope.grade },
    unit: scope.unit === null ? null : {
      teamId: scope.unit.teamId, name: scope.unit.unitName, short: scope.unit.short, departmentName: scope.unit.departmentName,
    },
    mode: opdDay ? "opd_day" : "plain",
    tiles: {
      booked: opdDay ? mine.booked : null, seen: opdDay ? mine.seen : null,
      waiting: opdDay ? mine.waiting : null, longestWaitMinutes: opdDay ? mine.longestWaitMinutes : null,
      resultsToReview: attention.filter((r) => r.kind === "imaging_unread" || r.kind === "lab_delta").length,
      papersToSign: attention.filter((r) => r.kind === "visit_open").length,
    },
    attention,
    tabCounts,
    unitOverview: lines.filter((l) => memberIds.includes(l.userId) && l.session !== "none").map(toWireLine),
    clocks,
    schedule: await scheduleOf(db, actor, at, scope.istDate, mine),
    team,
    brief: await towerBrief(db, actor, at),
    briefsWaiting: await briefsWaiting(db, actor, at),
    agentRuns: await runsFor(db, scope.unit?.teamId ?? null, actor.id, at),
  };
}
