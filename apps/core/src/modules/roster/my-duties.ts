import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { orgDepartments } from "../../kernel/db/schema/org";
import {
  rosterAssignments, rosterDutyWindows, rosterFlags, rosterPositions, rosterTeams,
} from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { addIstDays, istDateOfInstant, istMidnightUtc, unitOnTake } from "./calendar";
import { parentTeamOf } from "./memberships";
import { rosterSelf } from "./month";
import { coverRequests, myDutyRows, positionLabels, rosterTeamNames, toDutyRef } from "./swaps";
import { rosterFlagRaised } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { RosterSelf } from "./month";
import type { CoverRequestView, MyDuty } from "./swaps";

/**
 * ═══ 20-U U5c — MY DUTIES (`docs/design/2026-09-20-roster/MyDuties.dc.html`) ═══
 *
 * A resident's phone: today, the rest of the week, and on each duty still ahead *"I can't do
 * this"*. ONE person's duties — the reader's, asked with the actor's own id, never a parameter —
 * from the PUBLISHED roster (`effective` rows), with what their unit is doing each day, who is on
 * take now, the requests they have made or been asked, and their unit's senior resident if one is
 * in the building now (with the number, D6: the same person the who-is-on board shows, at the same
 * instant, to the same reader).
 */
export type MyDuties = {
  at: Date;
  days: string[];
  you: RosterSelf;
  duties: MyDuty[];
  /** The reader's department's unit on take now, by name. */
  onTake: null | { teamId: string; name: string; endsAt: Date };
  /** The reader's unit's senior resident on duty NOW, with a number when one is on file. */
  mySr: null | { userId: string; name: string; phone: string | null };
  requests: CoverRequestView[];
};

const WEEK_DAYS = 7;

/** The database's clock, as every other stamp in this module (V6). */
async function dbNow(exec: Db | Tx): Promise<Date> {
  const raw = ((await (exec as Db).execute(sql`select now() as "now"`)).rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

export async function myDuties(exec: Db | Tx, actor: Actor, at: Date): Promise<MyDuties> {
  await requireRosterAct(exec, actor, "read");
  const today = istDateOfInstant(at);
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => addIstDays(today, i));
  const from = istMidnightUtc(today);
  const to = istMidnightUtc(addIstDays(today, WEEK_DAYS));
  const rows = await myDutyRows(exec, actor, from, to);
  const positions = await positionLabels(exec);
  const teams = await rosterTeamNames(exec);

  const teamIds = [...new Set(rows.map((r) => r.teamId).filter((t): t is string => t !== null))];
  const windows = teamIds.length === 0 ? [] : await (exec as Db).select().from(rosterDutyWindows).where(and(
    inArray(rosterDutyWindows.teamId, teamIds), isNull(rosterDutyWindows.supersededAt),
    lt(rosterDutyWindows.startsAt, to), gt(rosterDutyWindows.endsAt, from),
  ));
  const duties: MyDuty[] = rows.map((r) => {
    const day = istDateOfInstant(r.startsAt);
    return {
      ...toDutyRef(r, positions, teams),
      activities: [...new Set(windows.filter((w) => w.teamId === r.teamId && istDateOfInstant(w.startsAt) === day).map((w) => w.activity))],
      upcoming: r.endsAt.getTime() > at.getTime(),
    };
  });

  const you = await rosterSelf(exec, actor, at);
  const home = actor.type === "user" ? await parentTeamOf(exec, actor.id, at) : undefined;
  let onTake: MyDuties["onTake"] = null;
  let mySr: MyDuties["mySr"] = null;
  if (home !== undefined) {
    const team = (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.id, home.teamId)))[0];
    if (team !== undefined) {
      const take = await unitOnTake(exec, team.departmentId, at);
      if (take.teamId !== null && take.endsAt !== null) onTake = { teamId: take.teamId, name: teams.get(take.teamId) ?? "", endsAt: take.endsAt };
      // The unit's SR in the building NOW: a live presence duty of a senior-resident post, on this unit.
      const sr = (await (exec as Db).select({ userId: rosterAssignments.userId, fullName: users.fullName, phone: users.phone })
        .from(rosterAssignments)
        .innerJoin(rosterPositions, eq(rosterPositions.key, rosterAssignments.positionKey))
        .innerJoin(users, eq(users.id, rosterAssignments.userId))
        .where(and(
          eq(rosterAssignments.effective, true), eq(rosterAssignments.teamId, team.id),
          eq(rosterPositions.cadre, "senior_resident"), ne(rosterAssignments.kind, "off"),
          lte(rosterAssignments.startsAt, at), gt(rosterAssignments.endsAt, at), ne(rosterAssignments.userId, actor.id),
        ))
        .orderBy(asc(rosterAssignments.startsAt)).limit(1))[0];
      if (sr !== undefined && sr.userId !== null) mySr = { userId: sr.userId, name: sr.fullName, phone: sr.phone };
    }
  }

  return {
    at, days, you, duties, onTake, mySr,
    requests: actor.type === "user" ? await coverRequests(exec, actor, { userId: actor.id }) : [],
  };
}

/* ═══════════════════════════════ "this is wrong" (register I22) ═══════════════════════════════ */

export type RosterFlagView = {
  flagId: string; departmentId: string | null; user: null | { userId: string; name: string };
  at: Date; note: string; raisedBy: { userId: string; name: string }; raisedAt: Date;
  /** May THIS reader mark it dealt with — `propose` at the flag's department. */
  youMayResolve: boolean;
};

export interface RaiseFlagInput { departmentId?: string | null; userId?: string | null; at: Date; note: string }

/**
 * ANY READER of the board may say a name on duty is wrong, in one line — `nag`, the matrix's act for
 * raising a hole ("a human may always raise one"). It changes nobody's duty. It is shown on the
 * board's holes card until somebody who can fix the roster says it is dealt with.
 *
 * AND IT PAGES THE DUTY MANAGER (owner 2026-10-04). `roster.flag_raised` is subscribed by the
 * kernel alerts consumer, which raises one bell row for whoever is duty manager at the instant it
 * was raised (`dutyManagersAt`: the roster's answer, else the role's holders) — never for the reader
 * who raised it. The flag stays on the board as well.
 */
export async function raiseFlag(tx: Tx, actor: Actor, input: RaiseFlagInput): Promise<{ flagId: string }> {
  await requireRosterAct(tx, actor, "nag", input.departmentId == null ? {} : { departmentId: input.departmentId });
  const note = input.note.trim();
  if (note === "" || note.length > 200) {
    throw new RosterError("invalid_window", "say in one line, 200 characters or fewer, what is wrong", { noteLength: note.length });
  }
  if (Number.isNaN(input.at.getTime())) throw new RosterError("invalid_window", "`at` is not an instant", {});
  const flagId = newId();
  const raisedAt = await dbNow(tx);
  await tx.insert(rosterFlags).values({
    id: flagId, departmentId: input.departmentId ?? null, userId: input.userId ?? null, at: input.at, note,
    raisedBy: actor.id, raisedAt, createdBy: actor.id, updatedBy: actor.id,
  });
  await appendEvent(tx, rosterFlagRaised.make({
    payload: { flagId, departmentId: input.departmentId ?? null, userId: input.userId ?? null, at: input.at.toISOString(), raisedAt: raisedAt.toISOString() },
    actor, correlationId: flagId,
  }));
  return { flagId };
}

export async function resolveFlag(tx: Tx, actor: Actor, flagId: string): Promise<void> {
  const f = (await (tx as Db).select().from(rosterFlags).where(eq(rosterFlags.id, flagId)).for("update"))[0];
  if (f === undefined) throw new RosterError("unknown_flag", undefined, { flagId });
  await requireRosterAct(tx, actor, "propose", f.departmentId === null ? {} : { departmentId: f.departmentId });
  if (f.resolvedAt !== null) throw new RosterError("flag_already_resolved", undefined, { flagId });
  const now = await dbNow(tx);
  await tx.update(rosterFlags).set({ resolvedBy: actor.id, resolvedAt: now, updatedBy: actor.id, updatedAt: now })
    .where(eq(rosterFlags.id, flagId));
}

/**
 * What the duty manager's bell row says about one flag — department, the reader's line, who raised
 * it and about whom. Staff names only; a flag concerns a duty, never a patient. Null for an unknown id.
 */
export async function flagForAlert(exec: Db | Tx, flagId: string): Promise<null | {
  raisedBy: string; raisedByName: string; departmentName: string | null; userName: string | null; note: string; raisedAt: Date;
}> {
  const f = (await (exec as Db).select().from(rosterFlags).where(eq(rosterFlags.id, flagId)))[0];
  if (f === undefined) return null;
  const ids = [f.raisedBy, ...(f.userId === null ? [] : [f.userId])];
  const names = new Map((await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.fullName]));
  const dept = f.departmentId === null ? null
    : (await (exec as Db).select({ name: orgDepartments.name }).from(orgDepartments).where(eq(orgDepartments.id, f.departmentId)))[0]?.name ?? null;
  return {
    raisedBy: f.raisedBy, raisedByName: names.get(f.raisedBy) ?? f.raisedBy, departmentName: dept,
    userName: f.userId === null ? null : names.get(f.userId) ?? f.userId, note: f.note, raisedAt: f.raisedAt,
  };
}

/** Open flags, newest first — the board's holes card. */
export async function openFlags(exec: Db | Tx, actor: Actor): Promise<RosterFlagView[]> {
  await requireRosterAct(exec, actor, "read");
  const rows = await (exec as Db).select().from(rosterFlags).where(isNull(rosterFlags.resolvedAt)).orderBy(desc(rosterFlags.raisedAt)).limit(50);
  const ids = [...new Set(rows.flatMap((r) => [r.raisedBy, ...(r.userId === null ? [] : [r.userId])]))];
  const names = new Map(ids.length === 0 ? [] : (await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.fullName]));
  const out: RosterFlagView[] = [];
  for (const r of rows) {
    let may = false;
    try {
      await requireRosterAct(exec, actor, "propose", r.departmentId === null ? {} : { departmentId: r.departmentId });
      may = true;
    } catch (e) { if (!(e instanceof RosterError)) throw e; }
    out.push({
      flagId: r.id, departmentId: r.departmentId,
      user: r.userId === null ? null : { userId: r.userId, name: names.get(r.userId) ?? r.userId },
      at: r.at, note: r.note, raisedBy: { userId: r.raisedBy, name: names.get(r.raisedBy) ?? r.raisedBy }, raisedAt: r.raisedAt,
      youMayResolve: may,
    });
  }
  return out;
}
