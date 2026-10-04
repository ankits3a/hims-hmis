import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { rosterHolidays, staffAbsences } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { rosterTeams } from "../../kernel/db/schema/roster";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "./calendar";
import { parentTeamOf } from "./memberships";
import { listOrgDepartments } from "./masters";
import type { StaffAbsenceKind } from "../../kernel/db/schema/roster";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ 20-U U8b — THE AEBAS TO-DO LIST (plan §2.2) ═══
 *
 * AEBAS — the biometric attendance system the Government requires a medical college to file
 * against — takes leave, tours and holidays **in advance only: "no retrospective
 * incorporation/updation is allowed"** (notice 18.06.2024). The roster knows every approved leave,
 * deputation and holiday before it happens, so it can say to the college's AEBAS nodal officer, each
 * day: *enter these today.* One tap records that a person did.
 *
 * **HMIS NEVER TALKS TO AEBAS.** Nothing here reads from it, writes to it or imitates it. The mark is
 * a record that a human entered the item there (`aebas_entered_at`/`_by`), nothing more.
 *
 * ═══ WHAT IS ON THE LIST ═══
 *
 *   · every APPROVED absence of a kind AEBAS holds (below), not yet marked, and
 *   · every declared holiday, not yet marked —
 *
 * each due **the IST day before it starts**. A holiday declared at 19:30 for tomorrow is due today,
 * which is the one case where an hour's delay costs every faculty member a day.
 *
 * DECIDED (20-U U8b) — **which absence kinds are AEBAS's.** Leave of every kind (CL, EL, ML,
 * maternity, paternity, compensatory off), deputation, academic leave (the conference, the tour) and
 * study leave. NOT `night_off` / `duty_off` — the roster's own rest after a duty, which the college's
 * office timings already account for — and NOT `abstaining` / `unauthorised`, which are not approved
 * leave and have nothing to enter in advance.
 *
 * DECIDED (20-U U8b) — **the nodal officer sees the KIND, never the reason.** AEBAS asks which kind of
 * leave is being entered, so the kind is the fact the officer is there to copy; the reason is the
 * approver's alone (D6) and this read never selects it.
 *
 * DECIDED (20-U U8b) — **who.** No role named "AEBAS nodal officer" exists, and the plan names none,
 * so the list and the mark are `publish` at hospital scope — the medical superintendent (and the
 * owner), or a person the MS has delegated `publish` to at hospital scope. That is the authority
 * `markAebasEntered` already asked for since R4, so the absence and the holiday mark agree.
 */

export const AEBAS_ABSENCE_KINDS: readonly StaffAbsenceKind[] = [
  "CL", "EL", "ML", "maternity", "paternity", "comp_off", "deputation", "academic", "study",
];

/**
 * How far back a MISSED item stays on the list (its start has passed, unmarked). It can no longer be
 * entered in advance; it is listed so the officer can see what slipped and, if it was entered after
 * all, mark it. After this long it is history, and the list is a to-do list.
 */
export const AEBAS_MISSED_DAYS = 30;

export type AebasItemState = "upcoming" | "due_today" | "missed";

export type AebasItem = {
  /** `absence:<id>` or `holiday:<YYYY-MM-DD>` — what the mark takes. */
  key: string;
  kind: "absence" | "holiday";
  /** The absence's kind (CL, deputation, …) or the holiday's (gazetted, declared, …). */
  what: string;
  /** IST days, inclusive. A holiday is one day. */
  firstDay: string;
  lastDay: string;
  /** The IST day before `firstDay` — when it must be in AEBAS by. */
  dueDay: string;
  state: AebasItemState;
  /** The person, for an absence. Never a phone, never a reason. */
  person: null | { userId: string; name: string; departmentName: string | null };
};

export type AebasTodo = {
  today: string;
  items: AebasItem[];
  /** Marked in the last week — so the officer sees the tap landed, and can see it if it was wrong. */
  recentlyEntered: AebasItem[];
};

const stateOf = (dueDay: string, firstDay: string, today: string): AebasItemState =>
  firstDay < today ? "missed" : dueDay <= today ? "due_today" : "upcoming";

/** The last IST day an absence touches: its end is exclusive. */
const lastDayOf = (endsAt: Date): string => istDateOfInstant(new Date(endsAt.getTime() - 1));

async function personLines(
  exec: Db | Tx, userIds: readonly string[], at: Date,
): Promise<Map<string, { name: string; departmentName: string | null }>> {
  const want = [...new Set(userIds)];
  if (want.length === 0) return new Map();
  const people = await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, want));
  const depts = new Map((await listOrgDepartments(exec)).map((d) => [d.id, d.name]));
  const out = new Map<string, { name: string; departmentName: string | null }>();
  for (const p of people) {
    const home = await parentTeamOf(exec, p.id, at);
    let departmentName: string | null = null;
    if (home !== undefined) {
      const team = (await (exec as Db).select({ departmentId: rosterTeams.departmentId }).from(rosterTeams).where(eq(rosterTeams.id, home.teamId)))[0];
      departmentName = team === undefined ? null : (depts.get(team.departmentId) ?? null);
    }
    out.set(p.id, { name: p.fullName, departmentName });
  }
  return out;
}

/**
 * The raw population, with no actor: what the census counts and the list draws. `entered` picks
 * the half — unmarked items still ahead (or missed within `AEBAS_MISSED_DAYS`), or marked ones since
 * `enteredSince`.
 */
async function aebasRows(exec: Db | Tx, now: Date, entered: false | { since: Date }): Promise<AebasItem[]> {
  const today = istDateOfInstant(now);
  const horizonStart = istMidnightUtc(addIstDays(today, -AEBAS_MISSED_DAYS));
  const absences = await (exec as Db).select({
    id: staffAbsences.id, userId: staffAbsences.userId, kind: staffAbsences.kind,
    startsAt: staffAbsences.startsAt, endsAt: staffAbsences.endsAt,
  }).from(staffAbsences).where(and(
    eq(staffAbsences.status, "approved"),
    inArray(staffAbsences.kind, [...AEBAS_ABSENCE_KINDS]),
    entered === false
      ? and(isNull(staffAbsences.aebasEnteredAt), gt(staffAbsences.startsAt, horizonStart))
      : and(isNotNull(staffAbsences.aebasEnteredAt), gte(staffAbsences.aebasEnteredAt, entered.since)),
  )).orderBy(asc(staffAbsences.startsAt), asc(staffAbsences.id));
  const holidays = await (exec as Db).select({ istDate: rosterHolidays.istDate, kind: rosterHolidays.kind })
    .from(rosterHolidays).where(entered === false
      ? and(isNull(rosterHolidays.aebasEnteredAt), gte(rosterHolidays.istDate, addIstDays(today, -AEBAS_MISSED_DAYS)))
      : and(isNotNull(rosterHolidays.aebasEnteredAt), gte(rosterHolidays.aebasEnteredAt, entered.since)))
    .orderBy(asc(rosterHolidays.istDate));

  const people = await personLines(exec, absences.map((a) => a.userId), now);
  const items: AebasItem[] = [
    ...absences.map((a): AebasItem => {
      const firstDay = istDateOfInstant(a.startsAt);
      const dueDay = addIstDays(firstDay, -1);
      const p = people.get(a.userId);
      return {
        key: `absence:${a.id}`, kind: "absence", what: a.kind,
        firstDay, lastDay: lastDayOf(a.endsAt), dueDay, state: stateOf(dueDay, firstDay, today),
        person: { userId: a.userId, name: p?.name ?? "", departmentName: p?.departmentName ?? null },
      };
    }),
    ...holidays.map((h): AebasItem => {
      const firstDay = String(h.istDate);
      const dueDay = addIstDays(firstDay, -1);
      return {
        key: `holiday:${firstDay}`, kind: "holiday", what: h.kind,
        firstDay, lastDay: firstDay, dueDay, state: stateOf(dueDay, firstDay, today), person: null,
      };
    }),
  ];
  const order: Record<AebasItemState, number> = { missed: 0, due_today: 1, upcoming: 2 };
  return items.sort((x, y) => order[x.state] - order[y.state] || x.dueDay.localeCompare(y.dueDay)
    || (x.person?.name ?? "").localeCompare(y.person?.name ?? "") || x.key.localeCompare(y.key));
}

/** The nodal officer's list. `publish` at hospital scope — see the header's DECIDED. */
export async function aebasTodo(exec: Db | Tx, actor: Actor, now: Date): Promise<AebasTodo> {
  await requireRosterAct(exec, actor, "publish");
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  return {
    today: istDateOfInstant(now),
    items: await aebasRows(exec, now, false),
    recentlyEntered: await aebasRows(exec, now, { since: weekAgo }),
  };
}

async function dbNow(exec: Db | Tx): Promise<Date> {
  const raw = ((await (exec as Db).execute(sql`select now() as "now"`)).rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

/**
 * One tap: the holiday has been entered in AEBAS. The absence's twin, `markAebasEntered`, is R4's.
 * Marking twice keeps the FIRST mark — who entered it, and when, is the fact; a second tap is not.
 */
export async function markHolidayAebasEntered(tx: Tx, actor: Actor, istDate: string): Promise<void> {
  await requireRosterAct(tx, actor, "publish");
  if (actor.type !== "user") throw new RosterError("act_not_available_to_actor", undefined, { act: "publish" });
  const row = (await (tx as Db).select().from(rosterHolidays).where(eq(rosterHolidays.istDate, istDate)).for("update"))[0];
  if (row === undefined) throw new RosterError("invalid_window", "no holiday is declared for that day", { istDate });
  if (row.aebasEnteredAt !== null) return;
  const now = await dbNow(tx);
  await tx.update(rosterHolidays)
    .set({ aebasEnteredAt: now, aebasEnteredBy: actor.id, updatedBy: actor.id, updatedAt: now })
    .where(eq(rosterHolidays.istDate, istDate));
}

/**
 * The census's read (`standup:check`, `hospital.aebas_entered_before_due`). No actor: the census
 * runs as the operator's shell.
 *
 * `population` is every AEBAS item the roster has EVER held (approved absences of AEBAS's kinds, and
 * holidays) — the row refuses to read green on an empty one, because a hospital that has never
 * approved a leave through the roster has not shown that anything reaches AEBAS on time; it has
 * shown nothing. `overdue` counts the unmarked items due today or earlier whose first day is today
 * or later: the ones that can still be entered and must be, now. A first day already past is
 * MISSED — AEBAS will not take it — and stays on the officer's screen, not on the census, which
 * would otherwise be red for a month about something nobody can repair.
 */
export async function aebasCensus(exec: Db | Tx, now: Date): Promise<{ population: number; overdue: number }> {
  const a = await (exec as Db).select({ n: sql<number>`count(*)::int` }).from(staffAbsences)
    .where(and(eq(staffAbsences.status, "approved"), inArray(staffAbsences.kind, [...AEBAS_ABSENCE_KINDS])));
  const h = await (exec as Db).select({ n: sql<number>`count(*)::int` }).from(rosterHolidays);
  const pending = await aebasRows(exec, now, false);
  return {
    population: (a[0]?.n ?? 0) + (h[0]?.n ?? 0),
    overdue: pending.filter((i) => i.state === "due_today").length,
  };
}
