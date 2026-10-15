import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { rosterHolidays, rosterModeDeclarations, rosterTeams } from "../../kernel/db/schema/roster";
import { orgDepartments } from "../../kernel/db/schema/org";
import { users } from "../../kernel/db/schema/auth";
import { listOrgDepartments } from "./masters";
import { requireRosterAct } from "./access";
import { addIstDays, declareHoliday, istDateOfInstant } from "./calendar";
import { declareSkeletonMode, withdrawSkeletonMode } from "./modes";
import { RosterError } from "./errors";
import { unitCountsAt } from "./teams";
import { ROSTER_HOLIDAY_KINDS, ROSTER_HOLIDAY_PATTERNS } from "../../kernel/db/schema/roster";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RosterHolidayKind, RosterHolidayPattern } from "../../kernel/db/schema/roster";

/**
 * 20-U I1 / I2 / I5 — **THE MEDICAL SUPERINTENDENT'S TWO DECLARATIONS, AS ONE READ AND THREE ACTS.**
 *
 * The domain was built in R7 (`calendar.ts` `declareHoliday`) and R8 (`modes.ts`
 * `declareSkeletonMode` / `withdrawSkeletonMode`) and had no door. This is the door's content: what
 * has been declared for the days ahead, and who may declare what. The acts are the domain's own
 * functions, called unchanged — each asks `requireRosterAct(…, "declare")` itself (MS, or a named
 * delegate of `declare_holiday` / `declare_mode`), and each now writes its event.
 *
 * DECIDED — **a declaration is for today or a day to come.** Both domain functions accept any day;
 * a holiday declared for last Wednesday would re-materialise last Wednesday's take windows under
 * the hospital's feet, and a strike "declared" after the fact is a correction (an amendment stamped
 * `after_the_fact`), not a declaration. Refused here, at the door, in a sentence.
 */

export const DECLARATIONS_DAYS = 30;
export const HOLIDAYS_LISTED = 40;

export interface DeclaredHoliday {
  istDate: string; kind: string; pattern: string; declaredByName: string | null; declaredAt: Date;
}
export interface DeclaredMode {
  declarationId: string; departmentId: string | null; departmentName: string | null; mode: string;
  istDate: string; reason: string; declaredByName: string | null; declaredAt: Date;
  withdrawnAt: Date | null; withdrawnByName: string | null; withdrawReason: string | null;
}
export interface DeclarationsView {
  /** IST dates, `[from, to)` — the window the skeleton declarations are listed for. */
  from: string;
  to: string;
  holidays: DeclaredHoliday[];
  modes: DeclaredMode[];
  /** The unit-running departments this reader may put on skeleton cover. */
  departments: { departmentId: string; code: string; name: string }[];
  youMay: { holiday: boolean; hospitalSkeleton: boolean; departmentSkeleton: boolean };
}

async function may(exec: Db | Tx, actor: Actor, departmentId?: string): Promise<boolean> {
  try {
    await requireRosterAct(exec, actor, "declare", departmentId === undefined ? {} : { departmentId });
    return true;
  } catch (e) {
    if (e instanceof RosterError) return false;
    throw e;
  }
}

export async function declarationsView(exec: Db | Tx, actor: Actor, now: Date): Promise<DeclarationsView> {
  await requireRosterAct(exec, actor, "read");
  const from = istDateOfInstant(now);
  const to = addIstDays(from, DECLARATIONS_DAYS);
  // Holidays are declared months ahead (the gazette) as well as the evening before: every one to
  // come is listed, up to a year's worth. Skeleton cover is a day at a time — the next thirty days.
  const holidays = await (exec as Db).select().from(rosterHolidays)
    .where(gte(rosterHolidays.istDate, from))
    .orderBy(asc(rosterHolidays.istDate)).limit(HOLIDAYS_LISTED);
  const modes = await (exec as Db).select().from(rosterModeDeclarations)
    .where(and(gte(rosterModeDeclarations.istDate, from), lt(rosterModeDeclarations.istDate, to)))
    .orderBy(asc(rosterModeDeclarations.istDate), asc(rosterModeDeclarations.declaredAt));

  const ids = [...new Set([
    ...holidays.map((h) => h.declaredBy), ...modes.map((m) => m.declaredBy),
    ...modes.flatMap((m) => (m.withdrawnBy === null ? [] : [m.withdrawnBy])),
  ])];
  const names = new Map(ids.length === 0 ? [] : (await (exec as Db).select({ id: users.id, fullName: users.fullName })
    .from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.fullName]));

  const departments = await listOrgDepartments(exec);
  const deptById = new Map(departments.map((d) => [d.id, d]));
  // Departments that run a CONFIRMED unit (`unitCountsAt`) — skeleton cover is declared for units that exist.
  const unitDepts = [...new Set((await (exec as Db).select({ departmentId: rosterTeams.departmentId, active: rosterTeams.active, validTo: rosterTeams.validTo })
    .from(rosterTeams).where(eq(rosterTeams.kind, "clinical_unit")))
    .filter((t) => unitCountsAt(t, now)).map((t) => t.departmentId))];

  const hospital = await may(exec, actor);
  const mine: DeclarationsView["departments"] = [];
  for (const id of unitDepts) {
    const d = deptById.get(id);
    if (d !== undefined && (hospital || await may(exec, actor, id))) mine.push({ departmentId: id, code: d.code, name: d.name });
  }
  mine.sort((a, b) => a.name.localeCompare(b.name));

  return {
    from, to,
    holidays: holidays.map((h) => ({
      istDate: h.istDate, kind: h.kind, pattern: h.pattern, declaredByName: names.get(h.declaredBy) ?? null, declaredAt: h.declaredAt,
    })),
    modes: modes.map((m) => ({
      declarationId: m.id, departmentId: m.departmentId,
      departmentName: m.departmentId === null ? null : (deptById.get(m.departmentId)?.name ?? null),
      mode: m.mode, istDate: String(m.istDate), reason: m.reason,
      declaredByName: names.get(m.declaredBy) ?? null, declaredAt: m.declaredAt,
      withdrawnAt: m.withdrawnAt, withdrawnByName: m.withdrawnBy === null ? null : (names.get(m.withdrawnBy) ?? null),
      withdrawReason: m.withdrawReason,
    })),
    departments: mine,
    youMay: { holiday: hospital, hospitalSkeleton: hospital, departmentSkeleton: mine.length > 0 },
  };
}

const notPast = (istDate: string, now: Date): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(istDate) || Number.isNaN(Date.parse(`${istDate}T00:00:00Z`))) {
    throw new RosterError("invalid_window", "that is not a calendar day", { istDate });
  }
  if (istDate < istDateOfInstant(now)) {
    throw new RosterError("invalid_window", "a declaration is for today or a day to come — a past day is corrected by an amendment", { istDate });
  }
};

export async function declareHolidayAct(
  tx: Tx, actor: Actor, body: { istDate: unknown; kind: unknown; pattern: unknown }, now: Date,
): Promise<void> {
  if (typeof body.istDate !== "string" || typeof body.kind !== "string" || typeof body.pattern !== "string"
    || !(ROSTER_HOLIDAY_KINDS as readonly string[]).includes(body.kind)
    || !(ROSTER_HOLIDAY_PATTERNS as readonly string[]).includes(body.pattern)) {
    throw new RosterError("invalid_window", "name the day, the kind of holiday and what it closes", {});
  }
  notPast(body.istDate, now);
  await declareHoliday(tx, actor, {
    istDate: body.istDate, kind: body.kind as RosterHolidayKind, pattern: body.pattern as RosterHolidayPattern,
  });
}

export async function declareModeAct(
  tx: Tx, actor: Actor, body: { departmentId: unknown; istDate: unknown; reason: unknown }, now: Date,
): Promise<void> {
  if ((body.departmentId !== null && (typeof body.departmentId !== "string" || body.departmentId === ""))
    || typeof body.istDate !== "string" || typeof body.reason !== "string") {
    throw new RosterError("invalid_window", "name the department (or the whole hospital), the day and the reason", {});
  }
  if (body.reason.trim().length > 500) {
    throw new RosterError("invalid_window", "a reason in 500 characters or fewer — somebody reads this at handover", {});
  }
  notPast(body.istDate, now);
  if (body.departmentId !== null
    && (await (tx as Db).select({ id: orgDepartments.id }).from(orgDepartments).where(eq(orgDepartments.id, body.departmentId))).length === 0) {
    throw new RosterError("invalid_window", "there is no such department", { departmentId: body.departmentId });
  }
  await declareSkeletonMode(tx, actor, { departmentId: body.departmentId, istDate: body.istDate, reason: body.reason });
}

export async function withdrawModeAct(tx: Tx, actor: Actor, declarationId: string, body: { reason: unknown }): Promise<void> {
  if (body.reason !== undefined && typeof body.reason !== "string") {
    throw new RosterError("invalid_window", "a withdrawal's reason, if given, is a sentence", {});
  }
  await withdrawSkeletonMode(tx, actor, declarationId, typeof body.reason === "string" ? body.reason : "");
}
