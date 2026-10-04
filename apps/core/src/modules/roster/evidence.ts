import { createHash } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  rosterAssignments, rosterHolidays, rosterTeamMemberships, rosterTeams, staffAbsences,
} from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "./calendar";
import { parentTeamOf } from "./memberships";
import { listOrgDepartments } from "./masters";
import { positionLabels, rosterTeamNames } from "./swaps";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ 20-U U8 — THE DUTY-EVIDENCE REPORT (owner ruling RU-3, 2026-09-20) ═══
 *
 * Per person, per day: **what the roster says they were rostered to**, and **what the hospital's
 * records show them doing** — theatre wheel-in and wheel-out today, from the OT module through its
 * own index; the labour room, casualty and ward rounds as those modules come to record a person.
 * Approved leave or deputation, and a declared holiday, are records too, and are stated.
 *
 * **IT STATES FACTS AND DRAWS NO CONCLUSION.** It is the paper a faculty member attaches to an AEBAS
 * regularisation request; the college decides what the facts mean. So no line says, or implies, that
 * a person was or was not at work — the words for that are kept off the sheet in both languages, and
 * `evidence.test.ts` reads every word of a rendered sheet to hold it there.
 *
 * ═══ WHAT IT NEVER CARRIES ═══
 *
 *   · **a leave's reason, or its kind** — D6: that a person was away on approved leave is a fact the
 *     roster may state; why, and whether it was medical, is the approver's alone. The absence read
 *     below does not select either column.
 *   · **a phone number** — the user read selects name, staff code and nothing else.
 *   · **anything about a patient** — `theatreTimesOf` returns the theatre, the role and two stamps.
 *
 * ═══ WHO MAY RUN IT ═══
 *
 * DECIDED (20-U U8) — the act `read_evidence`, granted on `roster.periods.publish` and checked AT
 * EACH PERSON'S OWN DEPARTMENT (their parent unit's, on the first day asked). The head of department
 * who answers for a unit's roster may state what it held; the medical superintendent and the owner,
 * holding publish at hospital scope, may for anybody. No new permission string: the people who may
 * certify a duty are exactly the people who may publish it, and a separate string would have to be
 * granted to the same holders. A person with no unit is checked at hospital scope. No machine and no
 * copilot may run it (the matrix's `never`): a paper that goes to a regulator is a person's act.
 */

/**
 * ═══ WHERE THE "WHAT THE RECORD SHOWS" COMES FROM — SOURCES REGISTER THEMSELVES ═══
 *
 * The OT module records theatre times; the labour room, casualty and ward rounds will record a
 * person later. Each is a module the roster must not import at load time — `ot`'s index reaches
 * `patients`, whose workflow reaches back into this module, and the cycle leaves `ot`'s manifest
 * half-built (measured: `standup-check.test.ts` failed to load). So a source module REGISTERS its
 * read here from its own Nest `onModuleInit` (`OtModule` → `registerOtDutyEvidence`), the
 * `registerDocumentRenderer` shape. The sheet names the sources it read, so a source that is not
 * wired cannot be mistaken for a day with nothing in it.
 */
export type TheatreEvidenceRow = {
  userId: string; role: "surgeon" | "anaesthetist"; listDate: string; theatreName: string; wheelIn: Date; wheelOut: Date | null;
};
export type TheatreEvidenceSource = (
  exec: Db | Tx, userIds: readonly string[], fromIstDate: string, toIstDate: string,
) => Promise<TheatreEvidenceRow[]>;
let theatreSource: TheatreEvidenceSource | null = null;

/** Registers the theatre's read. Keyed by being the one slot, so a second init replaces. Returns the unregister. */
export function registerTheatreEvidenceSource(source: TheatreEvidenceSource): () => void {
  theatreSource = source;
  return () => { if (theatreSource === source) theatreSource = null; };
}

export const EVIDENCE_MAX_DAYS = 31;
export const EVIDENCE_MAX_PEOPLE = 12;

export type EvidenceDuty = {
  positionLabel: string; teamName: string | null; startsAt: Date; endsAt: Date;
  /** `off` — the roster gave this person the day off; `duty` — anything else. */
  off: boolean;
  /** `call` — on call from outside; `site` — rostered on site. Null for an off row. */
  mode: "site" | "call" | null;
};
export type EvidenceTheatre = { role: "surgeon" | "anaesthetist"; theatreName: string; wheelIn: Date; wheelOut: Date | null };
export type EvidenceDay = {
  istDate: string;
  rostered: EvidenceDuty[];
  /** An APPROVED leave or deputation overlaps the day. No kind, no reason (D6). */
  approvedLeave: boolean;
  /** The hospital declared the day a holiday — its kind (gazetted, declared, …). */
  holiday: string | null;
  theatre: EvidenceTheatre[];
};
export type EvidencePerson = {
  userId: string; name: string; staffCode: string; grade: string | null; departmentName: string | null; unitName: string | null;
  days: EvidenceDay[];
};
export type DutyEvidence = {
  /** IST days, inclusive. */
  from: string; to: string;
  generatedAt: Date;
  generatedBy: string;
  /** The sheet's reference — on the paper beside the QR, and the print job's dedupe key. */
  ref: string;
  /** The records read — `roster`, `leave`, `holidays`, and `theatre` when the OT module is wired. */
  sources: string[];
  people: EvidencePerson[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= EVIDENCE_MAX_DAYS; d = addIstDays(d, 1)) out.push(d);
  return out;
}

export function assertEvidenceAsk(userIds: readonly string[], from: string, to: string): void {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
    throw new RosterError("invalid_window", "name the first and the last day as calendar days", { from, to });
  }
  if (to < from) throw new RosterError("invalid_window", "the last day comes before the first", { from, to });
  if (daysOf(from, to).length > EVIDENCE_MAX_DAYS) {
    throw new RosterError("invalid_window", `one sheet covers at most ${String(EVIDENCE_MAX_DAYS)} days — ask for a month at a time`, { from, to });
  }
  const ids = [...new Set(userIds)];
  if (ids.length === 0) throw new RosterError("invalid_window", "choose at least one person", {});
  if (ids.length > EVIDENCE_MAX_PEOPLE) {
    throw new RosterError("invalid_window", `one sheet covers at most ${String(EVIDENCE_MAX_PEOPLE)} people`, { people: ids.length });
  }
}

/** The department a person's evidence is asked at: their parent unit's on the first day, or none. */
async function homeOf(exec: Db | Tx, userId: string, at: Date): Promise<{ departmentId: string; teamId: string; grade: string } | null> {
  const m = await parentTeamOf(exec, userId, at);
  if (m === undefined) return null;
  const team = (await (exec as Db).select({ departmentId: rosterTeams.departmentId }).from(rosterTeams).where(eq(rosterTeams.id, m.teamId)))[0];
  return team === undefined ? null : { departmentId: team.departmentId, teamId: m.teamId, grade: m.grade };
}

export function evidenceRef(actorId: string, userIds: readonly string[], from: string, to: string, day: string): string {
  return createHash("sha256").update([actorId, [...new Set(userIds)].sort().join(","), from, to, day].join("|")).digest("hex").slice(0, 10).toUpperCase();
}

export async function dutyEvidence(
  exec: Db | Tx, actor: Actor, ask: { userIds: readonly string[]; from: string; to: string }, now: Date,
): Promise<DutyEvidence> {
  assertEvidenceAsk(ask.userIds, ask.from, ask.to);
  const ids = [...new Set(ask.userIds)];
  const firstAt = istMidnightUtc(ask.from);
  const days = daysOf(ask.from, ask.to);
  const rangeStart = firstAt;
  const rangeEnd = istMidnightUtc(addIstDays(ask.to, 1));

  // The act, at each person's own department — before a single row about them is read.
  const homes = new Map<string, Awaited<ReturnType<typeof homeOf>>>();
  for (const id of ids) {
    const home = await homeOf(exec, id, firstAt);
    homes.set(id, home);
    await requireRosterAct(exec, actor, "read_evidence", home === null ? {} : { departmentId: home.departmentId });
  }

  // Name and staff code. NOT the phone, NOT the e-mail — the select is the control.
  const people = await (exec as Db).select({ id: users.id, fullName: users.fullName, staffCode: users.staffCode })
    .from(users).where(inArray(users.id, ids));
  if (people.length !== ids.length) {
    const known = new Set(people.map((p) => p.id));
    throw new RosterError("unknown_user", undefined, { userId: ids.find((i) => !known.has(i)) ?? null });
  }
  const me = actor.type === "user"
    ? (await (exec as Db).select({ fullName: users.fullName }).from(users).where(eq(users.id, actor.id)))[0]?.fullName ?? actor.id
    : actor.id;

  const duties = await (exec as Db).select({
    userId: rosterAssignments.userId, positionKey: rosterAssignments.positionKey, teamId: rosterAssignments.teamId,
    startsAt: rosterAssignments.startsAt, endsAt: rosterAssignments.endsAt, mode: rosterAssignments.mode, kind: rosterAssignments.kind,
  }).from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true), inArray(rosterAssignments.userId, ids),
    lt(rosterAssignments.startsAt, rangeEnd), gt(rosterAssignments.endsAt, rangeStart),
  )).orderBy(asc(rosterAssignments.startsAt), asc(rosterAssignments.id));
  // Windows only: whether an approved absence touches the day. `kind` and `reason` are not selected.
  const away = await (exec as Db).select({ userId: staffAbsences.userId, startsAt: staffAbsences.startsAt, endsAt: staffAbsences.endsAt })
    .from(staffAbsences).where(and(
      eq(staffAbsences.status, "approved"), inArray(staffAbsences.userId, ids),
      lt(staffAbsences.startsAt, rangeEnd), gt(staffAbsences.endsAt, rangeStart),
    ));
  const holidays = new Map((await (exec as Db).select({ istDate: rosterHolidays.istDate, kind: rosterHolidays.kind })
    .from(rosterHolidays).where(and(gte(rosterHolidays.istDate, ask.from), lt(rosterHolidays.istDate, addIstDays(ask.to, 1)))))
    .map((h) => [String(h.istDate), h.kind]));
  const theatre = theatreSource === null ? [] : await theatreSource(exec, ids, ask.from, addIstDays(ask.to, 1));

  const positions = await positionLabels(exec);
  const teams = await rosterTeamNames(exec);
  const depts = new Map((await listOrgDepartments(exec)).map((d) => [d.id, d.name]));
  const byId = new Map(people.map((p) => [p.id, p]));

  const out: EvidencePerson[] = ids.map((id) => {
    const p = byId.get(id)!;
    const home = homes.get(id) ?? null;
    return {
      userId: id, name: p.fullName, staffCode: p.staffCode, grade: home?.grade ?? null,
      departmentName: home === null ? null : (depts.get(home.departmentId) ?? null),
      unitName: home === null ? null : (teams.get(home.teamId) ?? null),
      days: days.map((istDate): EvidenceDay => {
        const dayStart = istMidnightUtc(istDate);
        const dayEnd = istMidnightUtc(addIstDays(istDate, 1));
        return {
          istDate,
          rostered: duties.filter((d) => d.userId === id && istDateOfInstant(d.startsAt) === istDate).map((d) => ({
            positionLabel: positions.get(d.positionKey) ?? d.positionKey,
            teamName: d.teamId === null ? null : (teams.get(d.teamId) ?? null),
            startsAt: d.startsAt, endsAt: d.endsAt,
            off: d.kind === "off",
            mode: d.kind === "off" ? null : d.mode === "call" ? "call" : "site",
          })),
          approvedLeave: away.some((a) => a.userId === id && a.startsAt < dayEnd && a.endsAt > dayStart),
          holiday: holidays.get(istDate) ?? null,
          theatre: theatre.filter((t) => t.userId === id && t.listDate === istDate)
            .map((t) => ({ role: t.role, theatreName: t.theatreName, wheelIn: t.wheelIn, wheelOut: t.wheelOut })),
        };
      }),
    };
  });

  return {
    from: ask.from, to: ask.to, generatedAt: now, generatedBy: me,
    ref: evidenceRef(actor.id, ids, ask.from, ask.to, istDateOfInstant(now)),
    sources: ["roster", "leave", "holidays", ...(theatreSource === null ? [] : ["theatre"])],
    people: out,
  };
}

export type EvidencePickerDepartment = {
  departmentId: string; name: string;
  people: { userId: string; name: string; grade: string; unitName: string }[];
};

/**
 * The screen's picker: the people the reader may run the report for — every member of a unit in a
 * department where the reader holds `read_evidence`. A department the reader cannot certify is not
 * listed at all, so the screen never offers a name the server would refuse.
 */
export async function evidencePeople(exec: Db | Tx, actor: Actor, now: Date): Promise<EvidencePickerDepartment[]> {
  await requireRosterAct(exec, actor, "read");
  const rows = await (exec as Db).select({
    userId: rosterTeamMemberships.userId, grade: rosterTeamMemberships.grade, teamId: rosterTeamMemberships.teamId,
    departmentId: rosterTeams.departmentId, teamName: rosterTeams.name, fullName: users.fullName, active: users.active,
  }).from(rosterTeamMemberships)
    .innerJoin(rosterTeams, eq(rosterTeams.id, rosterTeamMemberships.teamId))
    .innerJoin(users, eq(users.id, rosterTeamMemberships.userId))
    .where(and(
      eq(rosterTeamMemberships.kind, "parent"),
      lt(rosterTeamMemberships.startsAt, now),
      or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, now)),
    ))
    .orderBy(asc(users.fullName));
  const depts = new Map((await listOrgDepartments(exec)).map((d) => [d.id, d.name]));
  const may = new Map<string, boolean>();
  const out = new Map<string, EvidencePickerDepartment>();
  for (const r of rows) {
    if (!r.active) continue;
    if (!may.has(r.departmentId)) {
      try {
        await requireRosterAct(exec, actor, "read_evidence", { departmentId: r.departmentId });
        may.set(r.departmentId, true);
      } catch (e) {
        if (!(e instanceof RosterError)) throw e;
        may.set(r.departmentId, false);
      }
    }
    if (may.get(r.departmentId) !== true) continue;
    const d = out.get(r.departmentId) ?? { departmentId: r.departmentId, name: depts.get(r.departmentId) ?? "", people: [] };
    d.people.push({ userId: r.userId, name: r.fullName, grade: r.grade, unitName: r.teamName });
    out.set(r.departmentId, d);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
