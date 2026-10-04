import { and, eq, gt, inArray, lt, lte, ne } from "drizzle-orm";
import { rosterAssignments, rosterPeriods, rosterTeams, staffAbsences } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { opdDoctors } from "../../kernel/db/schema/opd";
import { listOrgDepartments, listRosterPositions } from "./masters";
import { calloutList, onDutyNow, resolverEnabled, whoIsOn } from "./resolve";
import { backupUnit, departmentsWithoutPublishedCycle, istDateOfInstant, takeGaps, unitOnTake } from "./calendar";
import { skeletonModeOn } from "./modes";
import { unitCountsAt } from "./teams";
import type { Db, Tx } from "../../kernel/db/client";
import type { RosterAnswerSource } from "./resolve";
import type { OnTakeAnswer } from "./calendar";
import type { RosterPositionRow } from "./masters";

/**
 * 20-U U5a — **WHO IS ON NOW**, the hospital's unit board, as ONE read.
 *
 * Casualty, the front desk, the duty manager and every ward read the same board (design
 * `docs/design/2026-09-20-roster/OnNow.dc.html`, owner-approved 2026-09-20). It composes reads that
 * already exist — the calendar's `unitOnTake` / `backupUnit` / `takeGaps`, the resolver's
 * `onDutyNow` / `calloutList` / `whoIsOn` — and decides nothing of its own except WHICH COLUMN a
 * position belongs in. That classification is the one judgement here, and it is made from the
 * position master, not from a list of keys:
 *
 *   · **IN THE BUILDING** — the resident grades: cadre `intern`, `junior_resident`,
 *     `senior_resident`. These are the people a unit has on the floor.
 *   · **FACULTY ON CALL** — cadre `faculty` whose eligible role is `doctor` (today `faculty_on_call`
 *     and `unit_head`): a department's own consultants. Taken from `calloutList` so the order is the
 *     roster's (`call_tier`, then `ladder_rank`), and only the FIRST rung group is shown — the person
 *     a resident rings first. A VACANT first rung is shown as vacant, never skipped (the ladder's own
 *     rule: a hole must stay visible).
 *   · **NOT UNITS, BUT YOU WILL NEED THEM** — every other position except ward-level nursing: the
 *     hospital-wide specialists (radiologist, pathologist, anaesthetist on call — faculty whose
 *     eligible role is a specialty, not `doctor`), the medical officers (casualty, blood bank), the
 *     duty manager, the pharmacist and the night nursing supervisor.
 *   · **ward nursing** (cadre `nurse`, ladder rank below 3: staff nurse, ward in-charge) is per WARD,
 *     and belongs on a ward's board, not the hospital's. Left out on purpose.
 *
 * ═══ "PUBLISHED" MEANS THIS DEPARTMENT'S UNITS ARE ROSTERED, NOT "SOME ROSTER IS LIVE" ═══
 *
 * `onDutyNow` reaches hospital-wide periods too, which is right for a resolver and wrong for this
 * row: publish the duty manager's month and every department's `onDutyNow` reads `published` with
 * nobody in it — exactly the staffed-looking empty row this board exists not to draw. So a row is
 * `published` only when a live roster here declares a UNIT position (a resident grade or the
 * department's faculty). Anything else is reported with the resolver's own non-published source and
 * NO PEOPLE: an unpublished department never lists RBAC role-holders as though they were on.
 *
 * Phone numbers: D6 — only for the people IN THE BUILDING at `at` (`BoardPerson.phone`), nobody else.
 */

export interface BoardPerson {
  userId: string; name: string; positionKey: string; positionLabel: string; cadre: string;
  /**
   * D6 — the person's number on file (`users.phone`), carried ONLY here: a person in the building
   * at `at` is on duty at `at`, and that is the one place and time the plan lets a number be shown.
   * The faculty column and the services carry none (the approved board draws no call button there).
   */
  phone: string | null;
}
export interface BoardRung { userId: string | null; name: string | null; positionKey: string; positionLabel: string; callTier: number | null }
export interface BoardUnit { teamId: string; code: string; name: string; startsAt: Date; endsAt: Date }
export interface BoardDepartment {
  departmentId: string; code: string; name: string;
  /** How many clinical units the department runs — one unit means "one unit · every day". */
  units: number;
  source: RosterAnswerSource;
  /** D4 — skeleton cover declared for this department (or the hospital) today. */
  skeleton: boolean;
  unitOnTake: BoardUnit | null;
  backupUnit: BoardUnit | null;
  inTheBuilding: BoardPerson[];
  facultyOnCall: BoardRung[];
}
export interface BoardService {
  positionKey: string; positionLabel: string; cadre: string; source: RosterAnswerSource;
  people: { userId: string; name: string; departmentId: string | null }[];
}
export type BoardHoleKind = "no_take_cycle" | "take_gap" | "vacant_slot" | "absent_on_duty" | "skeleton_short";
export interface BoardHole {
  kind: BoardHoleKind; departmentId: string; departmentName: string; from: Date; to: Date;
  positionKey: string | null; positionLabel: string | null; userId: string | null; name: string | null;
  /**
   * 20-U I5 — `skeleton_short` only: how many duties of the department's strike day are vacant or
   * held by somebody away. One line per department, never one per absent resident. Null otherwise.
   */
  count: number | null;
}
/**
 * 2026-10-04 (owner) — a department whose OPD has doctors but which runs NO confirmed unit yet
 * (Paediatrics, sat by guest faculty). Not a unit row and never a hole: one quiet line, so the
 * board does not read as though the department were forgotten. `doctors` counts its active OPD doctors.
 */
export interface BoardDepartmentWithoutUnit { departmentId: string; code: string; name: string; doctors: number }
export interface OnNowBoard {
  at: Date;
  resolverEnabled: boolean;
  departments: BoardDepartment[];
  departmentsWithoutUnit: BoardDepartmentWithoutUnit[];
  services: BoardService[];
  holes: BoardHole[];
}

/** The look-ahead of "holes in the next 24 hours". */
export const BOARD_HORIZON_MS = 24 * 3_600_000;

const RESIDENT_CADRES = new Set(["intern", "junior_resident", "senior_resident"]);
type Column = "building" | "faculty" | "service" | "ward";

/** The one judgement on this board — see the header. Exported for the test that pins it. */
export function boardColumn(p: Pick<RosterPositionRow, "cadre" | "eligibleRoleKey" | "ladderRank">): Column {
  if (RESIDENT_CADRES.has(p.cadre)) return "building";
  if (p.cadre === "faculty" && p.eligibleRoleKey === "doctor") return "faculty";
  if (p.cadre === "nurse" && p.ladderRank < 3) return "ward";
  return "service";
}

const isUnitColumn = (c: Column | undefined): boolean => c === "building" || c === "faculty";

export async function onNowBoard(
  exec: Db | Tx, at: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<OnNowBoard> {
  const enabled = resolverEnabled(env);
  const positions = await listRosterPositions(exec);
  const posByKey = new Map(positions.map((p) => [p.key, p]));
  const columnOf = (key: string): Column | undefined => {
    const p = posByKey.get(key);
    return p === undefined ? undefined : boardColumn(p);
  };
  const labelOf = (key: string): string => posByKey.get(key)?.label ?? key;

  const departments = await listOrgDepartments(exec);
  const deptById = new Map(departments.map((d) => [d.id, d]));

  // The population: departments that RUN UNITS — a clinical unit a head has CONFIRMED and that is
  // not closed by `at` (`unitCountsAt`). A seeded-but-unconfirmed unit is our arithmetic, not a unit.
  const unitTeams = (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.kind, "clinical_unit")))
    .filter((t) => unitCountsAt(t, at));
  const teamById = new Map(unitTeams.map((t) => [t.id, t]));
  const unitCount = new Map<string, number>();
  for (const t of unitTeams) unitCount.set(t.departmentId, (unitCount.get(t.departmentId) ?? 0) + 1);

  const names = new Map<string, string>();
  const phones = new Map<string, string | null>();
  const nameOf = async (ids: readonly string[]): Promise<void> => {
    const missing = [...new Set(ids)].filter((i) => !names.has(i));
    if (missing.length === 0) return;
    const rows = await (exec as Db).select({ id: users.id, fullName: users.fullName, phone: users.phone }).from(users).where(inArray(users.id, missing));
    for (const r of rows) { names.set(r.id, r.fullName); phones.set(r.id, r.phone); }
  };

  const unitOf = async (answer: OnTakeAnswer): Promise<BoardUnit | null> => {
    if (answer.teamId === null || answer.startsAt === null || answer.endsAt === null) return null;
    const team = teamById.get(answer.teamId)
      ?? (await (exec as Db).select().from(rosterTeams).where(eq(rosterTeams.id, answer.teamId)))[0];
    if (team === undefined) return null;
    return { teamId: team.id, code: team.code, name: team.name, startsAt: answer.startsAt, endsAt: answer.endsAt };
  };

  const istDate = istDateOfInstant(at);
  const rows: BoardDepartment[] = [];
  for (const departmentId of [...unitCount.keys()]) {
    const dept = deptById.get(departmentId);
    if (dept === undefined) continue;
    const onDuty = await onDutyNow(exec, departmentId, at, env);
    const published = onDuty.source === "published" && onDuty.positions.some((p) => isUnitColumn(columnOf(p.positionKey)));

    const inTheBuilding: BoardPerson[] = [];
    const facultyOnCall: BoardRung[] = [];
    if (published) {
      const building = onDuty.positions
        .filter((p) => columnOf(p.positionKey) === "building")
        // Seniors first, as a ward whiteboard reads: SR, then JRs, then interns.
        .sort((a, b) => (posByKey.get(b.positionKey)!.ladderRank - posByKey.get(a.positionKey)!.ladderRank)
          || a.positionKey.localeCompare(b.positionKey));
      await nameOf(building.flatMap((p) => p.userIds));
      const seen = new Set<string>();
      const people: BoardPerson[] = [];
      for (const p of building) {
        const pos = posByKey.get(p.positionKey)!;
        const here = p.userIds.filter((u) => !seen.has(u))
          .map((userId) => ({
            userId, name: names.get(userId) ?? userId, positionKey: pos.key, positionLabel: pos.label, cadre: pos.cadre,
            phone: phones.get(userId) ?? null,
          }))
          .sort((x, y) => x.name.localeCompare(y.name));
        for (const h of here) seen.add(h.userId);
        people.push(...here);
      }
      inTheBuilding.push(...people);

      const rungs = (await calloutList(exec, departmentId, at, env)).filter((r) => columnOf(r.positionKey) === "faculty");
      const first = rungs[0];
      if (first !== undefined) {
        const group = rungs.filter((r) => r.callTier === first.callTier && r.ladderRank === first.ladderRank);
        await nameOf(group.flatMap((r) => (r.userId === null ? [] : [r.userId])));
        facultyOnCall.push(...group.map((r) => ({
          userId: r.userId, name: r.userId === null ? null : (names.get(r.userId) ?? r.userId),
          positionKey: r.positionKey, positionLabel: labelOf(r.positionKey), callTier: r.callTier,
        })));
      }
    }

    rows.push({
      departmentId, code: dept.code, name: dept.name, units: unitCount.get(departmentId) ?? 0,
      source: published ? "published" : (onDuty.source === "published" ? "static" : onDuty.source),
      skeleton: await skeletonModeOn(exec, departmentId, istDate),
      unitOnTake: await unitOf(await unitOnTake(exec, departmentId, at)),
      backupUnit: await unitOf(await backupUnit(exec, departmentId, at)),
      inTheBuilding, facultyOnCall,
    });
  }
  rows.sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));

  /* ─── NOT UNITS, BUT YOU WILL NEED THEM ─── */
  const livePeriods = await (exec as Db)
    .select({ departmentId: rosterPeriods.departmentId, coversPositions: rosterPeriods.coversPositions })
    .from(rosterPeriods)
    .where(and(eq(rosterPeriods.status, "published"), lte(rosterPeriods.startsAt, at), gt(rosterPeriods.endsAt, at)));

  const services: BoardService[] = [];
  for (const pos of positions.filter((p) => p.active && boardColumn(p) === "service")) {
    const declaring = livePeriods.filter((p) => p.coversPositions.includes(pos.key));
    if (!enabled || declaring.length === 0) {
      services.push({ positionKey: pos.key, positionLabel: pos.label, cadre: pos.cadre, source: "static", people: [] });
      continue;
    }
    // Ask once per declaring scope, so `whoIsOn` does the subtraction (absence, leavers, memberships).
    const scopes = [...new Set(declaring.map((p) => p.departmentId))];
    const people = new Map<string, { userId: string; name: string; departmentId: string | null }>();
    for (const departmentId of scopes) {
      const answer = await whoIsOn(exec, departmentId === null ? { position: pos.key } : { position: pos.key, departmentId }, at, env);
      if (answer.source !== "published") continue;
      await nameOf(answer.userIds);
      for (const userId of answer.userIds) {
        if (!people.has(userId)) people.set(userId, { userId, name: names.get(userId) ?? userId, departmentId });
      }
    }
    services.push({ positionKey: pos.key, positionLabel: pos.label, cadre: pos.cadre, source: "published", people: [...people.values()] });
  }
  // Each service's people carry the department of the SLOT they hold, so a hospital-wide period's
  // duty manager is placed where the roster put them rather than at "hospital".
  await placeServicePeople(exec, services, at);

  /* ─── HOLES IN THE NEXT 24 HOURS ─── */
  const until = new Date(at.getTime() + BOARD_HORIZON_MS);
  const holes: BoardHole[] = [];
  const hole = (h: Omit<BoardHole, "departmentName" | "positionLabel" | "count">): BoardHole => ({
    ...h, count: null, departmentName: deptById.get(h.departmentId)?.name ?? h.departmentId,
    positionLabel: h.positionKey === null ? null : labelOf(h.positionKey),
  });

  const noCycle = new Set(await departmentsWithoutPublishedCycle(exec, at));
  for (const r of rows) {
    if (noCycle.has(r.departmentId)) {
      holes.push(hole({ kind: "no_take_cycle", departmentId: r.departmentId, from: at, to: until, positionKey: null, userId: null, name: null }));
      continue;
    }
    for (const g of await takeGaps(exec, r.departmentId, at, until)) {
      holes.push(hole({ kind: "take_gap", departmentId: r.departmentId, from: g.from, to: g.to, positionKey: null, userId: null, name: null }));
    }
  }

  const upcoming = await (exec as Db)
    .select({ a: rosterAssignments })
    .from(rosterAssignments)
    .innerJoin(rosterPeriods, eq(rosterPeriods.id, rosterAssignments.periodId))
    .where(and(
      eq(rosterPeriods.status, "published"),
      eq(rosterAssignments.effective, true),
      ne(rosterAssignments.kind, "off"),
      lt(rosterAssignments.startsAt, until),
      gt(rosterAssignments.endsAt, at),
    ));
  const slots = upcoming.map((u) => u.a).filter((a) => columnOf(a.positionKey) !== "ward");

  for (const a of slots.filter((s) => s.userId === null)) {
    holes.push(hole({ kind: "vacant_slot", departmentId: a.departmentId, from: a.startsAt, to: a.endsAt, positionKey: a.positionKey, userId: null, name: null }));
  }

  const named = slots.filter((s) => s.userId !== null);
  if (named.length > 0) {
    const away = await (exec as Db).select().from(staffAbsences).where(and(
      eq(staffAbsences.status, "approved"),
      inArray(staffAbsences.userId, [...new Set(named.map((s) => s.userId!))]),
      lt(staffAbsences.startsAt, until),
      gt(staffAbsences.endsAt, at),
    ));
    const clashing = named.filter((s) => away.some((x) => x.userId === s.userId && x.startsAt < s.endsAt && x.endsAt > s.startsAt));
    await nameOf(clashing.map((s) => s.userId!));
    for (const s of clashing) {
      holes.push(hole({
        kind: "absent_on_duty", departmentId: s.departmentId, from: s.startsAt, to: s.endsAt,
        positionKey: s.positionKey, userId: s.userId, name: names.get(s.userId!) ?? s.userId,
      }));
    }
  }
  const grouped = await groupSkeletonHoles(exec, holes);
  holes.length = 0;
  holes.push(...grouped);
  holes.sort((x, y) => x.from.getTime() - y.from.getTime() || x.departmentName.localeCompare(y.departmentName) || x.kind.localeCompare(y.kind));

  /* ─── DEPARTMENTS WITHOUT A UNIT YET ─── */
  const doctorsByClinic = new Map<string, number>();
  for (const d of await (exec as Db).select({ departmentId: opdDoctors.departmentId }).from(opdDoctors)
    .innerJoin(users, eq(users.id, opdDoctors.userId))
    .where(and(eq(opdDoctors.active, true), eq(users.active, true)))) {
    doctorsByClinic.set(d.departmentId, (doctorsByClinic.get(d.departmentId) ?? 0) + 1);
  }
  const departmentsWithoutUnit: BoardDepartmentWithoutUnit[] = departments
    .filter((d) => !unitCount.has(d.id) && d.opdDepartmentId !== null && (doctorsByClinic.get(d.opdDepartmentId) ?? 0) > 0)
    .map((d) => ({ departmentId: d.id, code: d.code, name: d.name, doctors: doctorsByClinic.get(d.opdDepartmentId!) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { at, resolverEnabled: enabled, departments: rows, departmentsWithoutUnit, services, holes };
}

/**
 * 20-U I5 — **A STRIKE DAY IS ONE LINE PER DEPARTMENT.** On a day the department (or the hospital)
 * is declared on skeleton cover, its vacant duties and its duties held by somebody away are one
 * hole — "General Medicine · skeleton cover · 14 duties uncovered" — spanning the first to the last.
 * Forty lines of "Dr X is away" is the thousand findings D4 says a mode exists to replace. The
 * department-level holes (no take cycle, a take gap) are untouched: they are already one line.
 */
async function groupSkeletonHoles(exec: Db | Tx, holes: readonly BoardHole[]): Promise<BoardHole[]> {
  const out: BoardHole[] = [];
  const groups = new Map<string, BoardHole>();
  const cache = new Map<string, boolean>();
  for (const h of holes) {
    if (h.kind !== "vacant_slot" && h.kind !== "absent_on_duty") { out.push(h); continue; }
    const day = istDateOfInstant(h.from);
    const key = `${h.departmentId}\u0000${day}`;
    if (!cache.has(key)) cache.set(key, await skeletonModeOn(exec, h.departmentId, day));
    if (cache.get(key) !== true) { out.push(h); continue; }
    const g = groups.get(key);
    if (g === undefined) {
      const first: BoardHole = {
        kind: "skeleton_short", departmentId: h.departmentId, departmentName: h.departmentName,
        from: h.from, to: h.to, positionKey: null, positionLabel: null, userId: null, name: null, count: 1,
      };
      groups.set(key, first);
      out.push(first);
    } else {
      g.count = (g.count ?? 0) + 1;
      if (h.from < g.from) g.from = h.from;
      if (h.to > g.to) g.to = h.to;
    }
  }
  return out;
}

/**
 * A hospital-wide period has no department, but the SLOT does (`department_id` is never null on an
 * assignment). Replace a null with the department of the live slot the person holds for that position.
 */
async function placeServicePeople(exec: Db | Tx, services: BoardService[], at: Date): Promise<void> {
  const unplaced = services.flatMap((s) => s.people.filter((p) => p.departmentId === null).map((p) => ({ s, p })));
  if (unplaced.length === 0) return;
  const live = await (exec as Db).select({
    userId: rosterAssignments.userId, positionKey: rosterAssignments.positionKey, departmentId: rosterAssignments.departmentId,
  }).from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true),
    inArray(rosterAssignments.userId, [...new Set(unplaced.map((u) => u.p.userId))]),
    lte(rosterAssignments.startsAt, at),
    gt(rosterAssignments.endsAt, at),
    ne(rosterAssignments.kind, "off"),
  ));
  for (const { s, p } of unplaced) {
    p.departmentId = live.find((l) => l.userId === p.userId && l.positionKey === s.positionKey)?.departmentId ?? null;
  }
}
