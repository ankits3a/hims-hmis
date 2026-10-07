import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdDepartments, opdRxSets, orgDepartments, rosterTeamMemberships, rosterTeams, users } from "../../kernel/db/schema";
import { medicineIdsByBrandNames, medicinesByIds, ndpsClassByMedicine } from "../formulary";
import { doctorForUser } from "./masters";
import { OpdError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PHONE CONSULT (decision 0048, owner 2026-10-07) — "My sets" and the hospital's starter sets.
 *
 * Owner: *"Let doctors save their own sets, and add a small hospital starter list."* Decided by
 * delegation the same day: a starter set is signed once by its department's UNIT HEAD and is shown
 * to nobody before that; a set may hold antibiotics and may NEVER hold a controlled medicine.
 *
 * ═══ A SET FILLS A SCREEN, IT ISSUES NOTHING ═══
 * `applyable` lines are returned exactly as stored. They are not checked against a patient here,
 * because there is no patient here: the consult screen puts them on the visit, and the visit's own
 * pre-check and issue path (`prescriptions.ts`) run on every line for THAT patient, as for a line
 * the doctor typed. A set is a shortcut for typing and never a shortcut round a warning.
 *
 * ═══ CONTROLLED MEDICINES ═══
 * Schedule H1, Schedule X and NDPS moieties (`formulary`'s own classification — this module asks,
 * it does not keep a list). Refused on every write, by catalogue id where the line has one and by
 * exact catalogue name where it does not. A free-text line the catalogue cannot name is allowed —
 * it is the same legal free text a prescription may carry — and is still checked at issue.
 */
export const SET_MAX_LINES = 12;
export const SET_MAX_TESTS = 12;

const lineSchema = z.object({
  drug: z.string().trim().min(1).max(300),
  dose: z.string().max(100),
  route: z.string().max(100),
  frequency: z.string().max(100),
  durationDays: z.number().int().positive().max(3650).nullable(),
  instructions: z.string().max(2000).nullable(),
  medicineId: z.string().min(1).max(64).nullish(),
});
const testSchema = z.object({
  serviceId: z.string().min(1).max(64), code: z.string().min(1).max(64), name: z.string().min(1).max(300),
});
export const rxSetBodySchema = z.object({
  lines: z.array(lineSchema).max(SET_MAX_LINES),
  tests: z.array(testSchema).max(SET_MAX_TESTS),
  advice: z.string().max(2000).nullable(),
  /** "Review after N days" — printed advice, not the free follow-up window (that is the hospital's own rule). */
  reviewDays: z.number().int().positive().max(365).nullable(),
});
export type RxSetBody = z.infer<typeof rxSetBodySchema>;

export type RxSet = {
  id: string; scope: "doctor" | "department"; name: string; body: RxSetBody;
  departmentId: string | null; departmentName: string | null;
  mine: boolean; signed: boolean; signedByName: string | null; signedAt: string | null;
  /** May this caller sign (or re-sign) it — the department's unit head, and only for a starter set. */
  maySign: boolean;
};

function userOf(actor: Actor): string {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "sets are a doctor's surface");
  return actor.id;
}

/** The OPD departments whose unit this user HEADS today (roster's word is `head`). */
export async function headedOpdDepartments(db: Db | Tx, userId: string, now: Date): Promise<string[]> {
  const current = and(lte(rosterTeamMemberships.startsAt, now), or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, now)));
  const rows = await db.select({ opd: orgDepartments.opdDepartmentId })
    .from(rosterTeamMemberships)
    .innerJoin(rosterTeams, eq(rosterTeams.id, rosterTeamMemberships.teamId))
    .innerJoin(orgDepartments, eq(orgDepartments.id, rosterTeams.departmentId))
    .where(and(eq(rosterTeamMemberships.userId, userId), eq(rosterTeamMemberships.roleInTeam, "head"), eq(rosterTeams.active, true), current));
  return [...new Set(rows.map((r) => r.opd).filter((x): x is string => x !== null))].sort();
}

/** Refuses a body holding a controlled medicine. Returns the body with names trimmed. */
async function vetBody(db: Db | Tx, raw: unknown): Promise<RxSetBody> {
  const parsed = rxSetBodySchema.safeParse(raw);
  if (!parsed.success) throw new OpdError("invalid_rx_set", parsed.error.issues[0]?.message ?? "invalid set");
  const body = parsed.data;
  if (body.lines.length === 0 && body.tests.length === 0 && (body.advice ?? "").trim() === "") {
    throw new OpdError("invalid_rx_set", "a set needs at least one medicine, test or line of advice");
  }
  const byName = await medicineIdsByBrandNames(db, body.lines.filter((l) => (l.medicineId ?? null) === null).map((l) => l.drug));
  const ids = body.lines.map((l) => l.medicineId ?? byName.get(l.drug.toLowerCase()) ?? byName.get(l.drug) ?? null);
  const known = ids.filter((x): x is string => x !== null);
  if (known.length > 0) {
    const meds = await medicinesByIds(db, known);
    const ndps = await ndpsClassByMedicine(db, known);
    const bad = body.lines.filter((_, i) => {
      const id = ids[i];
      if (id === null || id === undefined) return false;
      const flag = meds.get(id)?.scheduleFlag ?? null;
      return flag === "H1" || flag === "X" || ndps.has(id);
    }).map((l) => l.drug);
    if (bad.length > 0) {
      throw new OpdError("rx_set_controlled", `a set cannot hold a controlled medicine: ${bad.join(", ")}`, { drugs: bad });
    }
  }
  return body;
}

function nameOf(raw: string): string {
  const name = raw.trim();
  if (name === "" || name.length > 60) throw new OpdError("invalid_rx_set", "a set needs a name of up to 60 characters");
  return name;
}

/**
 * What this doctor may use: their own, then their department's SIGNED starter sets. A unit head
 * also sees the unsigned starter sets of the departments they head (to sign them), and any doctor
 * sees the unsigned ones THEY drafted for their own department (to finish them).
 */
export async function listRxSets(db: Db, actor: Actor, now: Date = new Date()): Promise<{ items: RxSet[]; headOf: string[]; departmentId: string | null }> {
  const userId = userOf(actor);
  const doctor = await doctorForUser(db, userId);
  const headOf = await headedOpdDepartments(db, userId, now);
  const deptIds = [...new Set([...(doctor === null ? [] : [doctor.departmentId]), ...headOf])];
  const rows = await db.select().from(opdRxSets)
    .where(and(eq(opdRxSets.active, true), or(
      and(eq(opdRxSets.scope, "doctor"), eq(opdRxSets.ownerUserId, userId)),
      deptIds.length === 0 ? eq(opdRxSets.id, "") : and(eq(opdRxSets.scope, "department"), inArray(opdRxSets.departmentId, deptIds)),
    )))
    .orderBy(asc(opdRxSets.scope), asc(opdRxSets.name));
  const depts = deptIds.length === 0 ? [] : await db.select({ id: opdDepartments.id, name: opdDepartments.name }).from(opdDepartments).where(inArray(opdDepartments.id, deptIds));
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const signerIds = [...new Set(rows.map((r) => r.signedBy).filter((x): x is string => x !== null))];
  const signerName = new Map<string, string>();
  if (signerIds.length > 0) {
    for (const u of await db.select({ id: users.id, fullName: users.fullName, username: users.username }).from(users).where(inArray(users.id, signerIds))) {
      signerName.set(u.id, u.fullName === "" ? u.username : u.fullName);
    }
  }
  const items: RxSet[] = [];
  for (const r of rows) {
    const body = rxSetBodySchema.safeParse(r.body);
    if (!body.success) continue; // a row this build cannot read is not offered, and nothing else is lost
    const dept = r.departmentId;
    const head = dept !== null && headOf.includes(dept);
    const signed = r.signedAt !== null;
    if (r.scope === "department" && !signed && !head && r.createdBy !== userId) continue;
    items.push({
      id: r.id, scope: r.scope as RxSet["scope"], name: r.name, body: body.data,
      departmentId: dept, departmentName: dept === null ? null : deptName.get(dept) ?? null,
      mine: r.scope === "doctor", signed, signedByName: r.signedBy === null ? null : signerName.get(r.signedBy) ?? null,
      signedAt: r.signedAt === null ? null : r.signedAt.toISOString(), maySign: r.scope === "department" && head,
    });
  }
  return { items, headOf, departmentId: doctor?.departmentId ?? null };
}

export type SaveRxSetInput = { id?: string | null; scope: "doctor" | "department"; departmentId?: string | null; name: string; body: unknown };

/**
 * Save (or replace) a set. A doctor's own is theirs alone — the owner comes from the ACTOR, never
 * the body. A starter set may be drafted by a doctor of that department or its unit head, and ANY
 * change to it clears the signature: what the unit head signed is what doctors see, word for word.
 */
export async function saveRxSet(tx: Tx, actor: Actor, input: SaveRxSetInput, now: Date = new Date()): Promise<{ setId: string }> {
  const userId = userOf(actor);
  const name = nameOf(input.name);
  const body = await vetBody(tx, input.body);
  const doctor = await doctorForUser(tx, userId);
  let departmentId: string | null = null;
  if (input.scope === "department") {
    const headOf = await headedOpdDepartments(tx, userId, now);
    departmentId = input.departmentId ?? doctor?.departmentId ?? null;
    if (departmentId === null || !(doctor?.departmentId === departmentId || headOf.includes(departmentId))) {
      throw new OpdError("rx_set_not_permitted", "a starter set is written by a doctor of that department or its unit head");
    }
  } else if (doctor === null) {
    throw new OpdError("not_a_doctor", "no OPD doctor profile for this user");
  }
  const id = input.id ?? null;
  if (id !== null) {
    const rows = await tx.select().from(opdRxSets).where(and(eq(opdRxSets.id, id), eq(opdRxSets.active, true)));
    const row = rows[0];
    const mayEdit = row !== undefined && row.scope === input.scope
      && (row.scope === "doctor" ? row.ownerUserId === userId : row.departmentId === departmentId);
    if (!mayEdit) throw new OpdError("unknown_rx_set", `unknown set ${id}`);
    await tx.update(opdRxSets).set({ name, body, signedBy: null, signedAt: null, updatedBy: userId, updatedAt: now }).where(eq(opdRxSets.id, id));
    return { setId: id };
  }
  const setId = newId();
  await tx.insert(opdRxSets).values({
    id: setId, scope: input.scope, ownerUserId: input.scope === "doctor" ? userId : null, departmentId,
    name, body, createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now,
  });
  return { setId };
}

/** The unit head's signature. Re-vets the body: a medicine re-classified as controlled since the draft is refused here too. */
export async function signRxSet(tx: Tx, actor: Actor, setId: string, now: Date = new Date()): Promise<void> {
  const userId = userOf(actor);
  const rows = await tx.select().from(opdRxSets).where(and(eq(opdRxSets.id, setId), eq(opdRxSets.active, true), eq(opdRxSets.scope, "department")));
  const row = rows[0];
  if (row === undefined) throw new OpdError("unknown_rx_set", `unknown set ${setId}`);
  const headOf = await headedOpdDepartments(tx, userId, now);
  if (row.departmentId === null || !headOf.includes(row.departmentId)) {
    throw new OpdError("rx_set_not_permitted", "a starter set is signed by its department's unit head");
  }
  await vetBody(tx, row.body);
  await tx.update(opdRxSets).set({ signedBy: userId, signedAt: now, updatedBy: userId, updatedAt: now }).where(eq(opdRxSets.id, setId));
}

/** Retired, never deleted. Your own set, or a starter set of a department you head. Not-yours answers not-found. */
export async function retireRxSet(tx: Tx, actor: Actor, setId: string, now: Date = new Date()): Promise<void> {
  const userId = userOf(actor);
  const rows = await tx.select().from(opdRxSets).where(and(eq(opdRxSets.id, setId), eq(opdRxSets.active, true)));
  const row = rows[0];
  const headOf = row?.scope === "department" ? await headedOpdDepartments(tx, userId, now) : [];
  const may = row !== undefined && (row.scope === "doctor"
    ? row.ownerUserId === userId
    : (row.departmentId !== null && headOf.includes(row.departmentId)) || (row.signedAt === null && row.createdBy === userId));
  if (!may) throw new OpdError("unknown_rx_set", `unknown set ${setId}`);
  await tx.update(opdRxSets).set({ active: false, updatedBy: userId, updatedAt: now }).where(eq(opdRxSets.id, setId));
}
