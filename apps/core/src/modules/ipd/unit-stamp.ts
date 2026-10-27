import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { appendEvent } from "../../kernel/events/append";
import { ipdAdmissions, ipdUnitTransfers, rosterTeams } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { doctorUnitsOn, orgDepartmentByCode, unitOnTake } from "../roster";
import { lockAdmission, provenanceOf, requireIpdPermission } from "./admission-core";
import { IPD_PLACED_STATES } from "./admission-place";
import { IpdRefusal } from "./errors";
import { isConsultant } from "./rounds-team";
import { IPD_ROUND_SIGN } from "./permissions";
import { admissionUnitTransferred } from "./unit-events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * #962 (spec docs/specs/962-doctor-desk-ward.md; plan 2026-10-04-doctor-desk §4.1 I1) — WHICH UNIT AN ADMISSION BELONGS
 * TO, decided ONCE, at admission.
 *
 * THE RULE (DECIDED, Indian teaching-hospital practice; owner approved the spec 2026-10-26):
 *   - an ER admission belongs to the unit that was ON TAKE when the patient came through the ER door (`unitOnTake` of
 *     the department at `er_arrived_at`) — at 07:55 that is last night's unit, even when the desk enters it at 08:10;
 *   - any other admission (OPD advice, direct, transfer-in, OT conversion, downtime) belongs to the admitting
 *     consultant's clinical unit on the day (the roster's parent membership; the same rule `treatingTeamOf` reads).
 *   - an ER admission with no take window published falls back to the consultant's unit; a consultant in no unit with
 *     no take window leaves the stamp null — absent, never guessed.
 * The department of the take is the admission's own department (its code, when it names an org department), else the
 * consultant's unit's department.
 *
 * The stamp is written in the admit transaction only while it is null, and never updated afterwards. A change of unit
 * is an `ipd_unit_transfers` row and the `ipd.admission.unit_transferred` event (`transferUnit`); the unit at an
 * instant is the newest such row at or before it, else the stamp, else (rows admitted before #962) the consultant's
 * unit on that day.
 */

async function takeDepartmentOf(exec: Db | Tx, a: Pick<AdmissionRow, "department">, ownDepartmentId: string | null): Promise<string | null> {
  if (a.department !== null && a.department.trim() !== "") {
    const org = await orgDepartmentByCode(exec, a.department.trim().toUpperCase());
    if (org !== undefined) return org.id;
  }
  return ownDepartmentId;
}

/** The unit an admission belongs to on being admitted at `at` (the rule above). */
export async function unitOnAdmission(exec: Db | Tx, a: AdmissionRow, at: Date, erArrivedAt: Date | null): Promise<string | null> {
  const own = (await doctorUnitsOn(exec, istDayString(at))).find((u) => u.userId === a.consultantId) ?? null;
  if (a.source === "er") {
    const arrived = erArrivedAt ?? a.erArrivedAt ?? at;
    const dept = await takeDepartmentOf(exec, a, own?.departmentId ?? null);
    if (dept !== null) {
      const take = await unitOnTake(exec, dept, arrived);
      if (take.teamId !== null) return take.teamId;
    }
  }
  return own?.teamId ?? null;
}

/**
 * Stamps the unit inside the admit transaction (called by every admit path right after the row moves to `admitted`).
 * Writes only while the stamp is null, so a retried or re-entered admit never moves it.
 */
export async function stampUnitIn(tx: Tx, admissionId: string, at: Date, erArrivedAt: Date | null = null): Promise<string | null> {
  const a = (await tx.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined) throw new IpdRefusal("admission_not_found");
  if (a.admittedUnderTeamId !== null) return a.admittedUnderTeamId;
  const teamId = await unitOnAdmission(tx, a, at, erArrivedAt);
  if (teamId === null) return null;
  await tx.update(ipdAdmissions).set({ admittedUnderTeamId: teamId })
    .where(and(eq(ipdAdmissions.id, a.id), isNull(ipdAdmissions.admittedUnderTeamId)));
  return teamId;
}

type UnitFacts = Pick<AdmissionRow, "id" | "consultantId" | "admittedUnderTeamId">;

/**
 * Each admission's unit at `at`: the newest unit-transfer row at or before `at`, else the stamp, else (an admission
 * from before #962) the consultant's unit on the IST day of `at`. Null when none of the three names one.
 */
export async function unitsOfAt(exec: Db | Tx, admissions: readonly UnitFacts[], at: Date, units?: Map<string, string>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (admissions.length === 0) return out;
  const moves = await (exec as Db).select({ admissionId: ipdUnitTransfers.admissionId, toTeamId: ipdUnitTransfers.toTeamId }).from(ipdUnitTransfers)
    .where(and(inArray(ipdUnitTransfers.admissionId, admissions.map((a) => a.id)), lte(ipdUnitTransfers.at, at)))
    .orderBy(desc(ipdUnitTransfers.at), desc(ipdUnitTransfers.recordedAt));
  const moved = new Map<string, string>();
  for (const m of moves) if (!moved.has(m.admissionId)) moved.set(m.admissionId, m.toTeamId);
  let byUser = units;
  for (const a of admissions) {
    const direct = moved.get(a.id) ?? a.admittedUnderTeamId;
    if (direct !== null) { out.set(a.id, direct); continue; }
    byUser ??= new Map((await doctorUnitsOn(exec, istDayString(at))).map((u) => [u.userId, u.teamId] as const));
    out.set(a.id, byUser.get(a.consultantId) ?? null);
  }
  return out;
}

export async function unitOfAt(exec: Db | Tx, a: UnitFacts, at: Date): Promise<string | null> {
  return (await unitsOfAt(exec, [a], at)).get(a.id) ?? null;
}

const TransferUnitInput = z.strictObject({
  admissionId: z.string().min(1).max(64),
  toTeamId: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(500),
});

/**
 * #962 — A CHANGE OF UNIT: an append-only row and an event, never an edit of the stamp. Minimal by design (a unit
 * transfer screen is out of scope of part 1): a CONSULTANT of the unit the patient is under, or of the unit taking
 * them, with `ipd.round.sign`. The patient must be on a bed; the target must be a clinical unit that counts at `now`.
 */
export async function transferUnit(
  db: Db, actor: Actor, raw: unknown, opts: { now?: Date } = {},
): Promise<{ transferId: string; fromTeamId: string | null; toTeamId: string }> {
  const input = TransferUnitInput.parse(raw);
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!(IPD_PLACED_STATES as readonly string[]).includes(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    const team = (await tx.select().from(rosterTeams).where(eq(rosterTeams.id, input.toTeamId)))[0];
    const counts = team !== undefined && team.kind === "clinical_unit" && (team.validTo === null ? team.active : team.validTo > at);
    if (!counts) throw new IpdRefusal("state_changed", "Not a clinical unit", { toTeamId: input.toTeamId });
    const from = await unitOfAt(tx, a, at);
    if (from === input.toTeamId) throw new IpdRefusal("state_changed", "Already in this unit", { toTeamId: input.toTeamId });
    const mine = (await doctorUnitsOn(tx, istDayString(at))).find((u) => u.userId === actor.id)?.teamId ?? null;
    const allowed = actor.type === "user" && mine !== null && (mine === from || mine === input.toTeamId) && await isConsultant(tx, actor.id, at);
    if (!allowed) throw new IpdRefusal("not_treating_consultant");
    const transferId = newId();
    await tx.insert(ipdUnitTransfers).values({
      id: transferId, admissionId: a.id, fromTeamId: from, toTeamId: input.toTeamId, at, reason: input.reason, recordedBy: actor.id, recordedAt: at,
    });
    await appendEvent(tx, admissionUnitTransferred.make({
      payload: { transferId, admissionId: a.id, fromTeamId: from, toTeamId: input.toTeamId, at: at.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, encounterId: a.id, occurredAt: at,
    }));
    return { transferId, fromTeamId: from, toTeamId: input.toTeamId };
  });
}
