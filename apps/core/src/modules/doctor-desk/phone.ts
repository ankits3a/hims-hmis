import type { Actor, ActChoice, WireHandledRow, WireNow, WireProfessor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { criticalCallsByIds } from "../lab";
import { getPatientSummaries } from "../patients";
import { deskLevel, deskScope, namesOf, patientOf } from "./scope";
import type { DeskScope } from "./scope";
import { waitingOn } from "./waiting-on";
import { owedByUnit, withNudgedBy } from "./owed";
import { actsInTeam, minutesBetween } from "./acts";
import { rateItems } from "./ratings";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ DD-1.4 / DD-1.5 — THE TWO PHONE BOARDS, their OPD and roster parts (web views) ═══
 *
 * `Main.dc.html` (the SR's "Now") and `Professor.dc.html`. Ward parts — NEXT ward round, NEWS2, FLOW ·
 * beds and money, the Professor's pulse of beds — are ABSENT until DD-IPD (plan §3.0), never zeros.
 * The ON TAKE strip, the week strip and "Wrong?" are the roster's own `GET /roster/my-duties` and
 * `POST /roster/flags`; "Needs your signature" is the roster's own cover requests and the approvals
 * worklist — the phone calls the SAME routes the desktop does, so an approval on the phone IS the
 * desktop's decision (DD-1.4 acceptance). This file serves only what the Desk itself decides.
 */
const youOf = (scope: DeskScope, actor: Actor): WireNow["you"] => ({ userId: actor.id, name: scope.name, grade: scope.grade });
const unitOf = (scope: DeskScope): WireNow["unit"] => scope.unit === null ? null : {
  teamId: scope.unit.teamId, name: scope.unit.unitName, short: scope.unit.short, departmentName: scope.unit.departmentName,
};

/** The SR's Now: NOW = my criticals (red open, amber read back with no act), TODAY = reports to open and visits to finish. */
export async function nowView(db: Db, actor: Actor, at: Date): Promise<WireNow> {
  const scope = await deskScope(db, actor, at);
  const rows = await waitingOn(db, actor, at, scope.istDate);
  return {
    at: at.toISOString(), istDate: scope.istDate, you: youOf(scope, actor), unit: unitOf(scope),
    scope: await deskLevel(db, actor, scope, at),
    now: rows.filter((r) => r.tab === "critical"),
    today: rows.filter((r) => r.kind === "imaging_unread" || r.kind === "visit_open"),
  };
}

export const HANDLED_WINDOW_HOURS = 24;
export const PROFESSOR_OWED_SHOWN = 3;

/**
 * "Handled without you": lab criticals in my unit that somebody else acted on in the last day. Names a
 * test and a patient, so the kernel's rules apply: a restricted test is dropped unless I ordered it or
 * hold `orders.read.restricted` (DD11, as `lab/patient-results.ts`), and a confidential patient shows by
 * alias (`patientOf`).
 */
export async function handledWithoutYou(db: Db, actor: Actor, scope: DeskScope, at: Date): Promise<WireHandledRow[]> {
  if (scope.unit === null) return [];
  const acts = (await actsInTeam(db, [scope.unit.teamId], new Date(at.getTime() - HANDLED_WINDOW_HOURS * 3_600_000)))
    .filter((a) => a.actorId !== actor.id && a.rowKey.startsWith("lab_critical:"));
  if (acts.length === 0) return [];
  const calls = new Map((await criticalCallsByIds(db, acts.map((a) => a.rowKey.slice("lab_critical:".length)))).map((c) => [c.id, c] as const));
  const canSeeRestricted = actor.type === "user" && await hasPermission(db, actor.id, "orders.read.restricted", "hospital");
  const visible = acts.filter((a) => {
    const c = calls.get(a.rowKey.slice("lab_critical:".length));
    return c !== undefined && (!c.restricted || canSeeRestricted || c.orderingClinicianId === actor.id);
  });
  const summaries = new Map((await getPatientSummaries(db, actor, visible.map((a) => calls.get(a.rowKey.slice(13))!.patientId))).map((s) => [s.requestedId, s] as const));
  const names = await namesOf(db, visible.map((a) => a.actorId));
  return visible
    .sort((a, b) => b.actedAt.getTime() - a.actedAt.getTime())
    .map((a): WireHandledRow => {
      const c = calls.get(a.rowKey.slice(13))!;
      return {
        key: a.rowKey, analyte: c.analyte, value: c.value ?? "", unit: c.unit ?? "",
        patient: patientOf(summaries.get(c.patientId), c.patientId),
        by: { userId: a.actorId, name: names.get(a.actorId) ?? "" },
        choice: a.choice as ActChoice, minutes: minutesBetween(a.openedAt, a.actedAt), actedAt: a.actedAt.toISOString(),
      };
    });
}

export async function professorView(db: Db, actor: Actor, at: Date): Promise<WireProfessor> {
  const scope = await deskScope(db, actor, at);
  const owedRaw = scope.unit === null ? [] : await owedByUnit(db, scope.members, at).catch(() => []);
  const owed = (await withNudgedBy(db, owedRaw, actor.id)).sort((a, b) => a.since.localeCompare(b.since));
  return {
    at: at.toISOString(), istDate: scope.istDate, you: youOf(scope, actor), unit: unitOf(scope),
    scope: await deskLevel(db, actor, scope, at),
    owed: owed.slice(0, PROFESSOR_OWED_SHOWN), owedTotal: owed.length,
    past: owed.filter((r) => Date.parse(r.dueAt) < at.getTime()).length,
    handled: await handledWithoutYou(db, actor, scope, at).catch(() => []),
    toRate: await rateItems(db, actor, scope).catch(() => []),
  };
}
