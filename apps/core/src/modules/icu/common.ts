import { and, eq, inArray, isNull } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { ipdAdmissions, ipdBedStays, patients, resources, roleAssignments } from "../../kernel/db/schema";
import { IcuError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

/** ICU IC-1 (#984) — the helpers every ICU file shares. */
export type Exec = Db | Tx;

export const ICU_SYSTEM: Actor = { type: "system", id: "icu" };

export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new IcuError("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

export const inTx = <T>(exec: Exec, fn: (t: Tx) => Promise<T>): Promise<T> => (exec as Db).transaction(fn);

export async function requirePermission(db: Exec, actor: Actor, permission: string): Promise<void> {
  if (actor.type === "system") return;
  if (actor.type !== "user" || !(await hasPermission(db as Db, actor.id, permission, "hospital"))) {
    throw new IcuError("icu_forbidden", { permission });
  }
}

export async function holdsAnyRole(db: Exec, userId: string, roleKeys: readonly string[]): Promise<boolean> {
  const rows = await (db as Db).select({ roleKey: roleAssignments.roleKey }).from(roleAssignments)
    .where(and(eq(roleAssignments.userId, userId), inArray(roleAssignments.roleKey, [...roleKeys])));
  return rows.length > 0;
}

export async function usersWithRole(db: Exec, roleKey: string): Promise<string[]> {
  const rows = await (db as Db).selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments).where(eq(roleAssignments.roleKey, roleKey));
  return rows.map((r) => r.userId).sort();
}

export const istDay = (at: Date): string => istDayString(at);

/** The admission states in which the patient is in a bed. */
export const PLACED = ["admitted", "transferring", "fit_declared", "discharging"] as const;

export type IcuPlacement = {
  admissionId: string; patientId: string; admissionNo: string | null; consultantId: string; department: string | null;
  state: string; admittedAt: Date | null; bedId: string; bedName: string; bedClass: string; hallId: string; icuBed: boolean;
};

/** The hall a bed belongs to: its ward/hall parent (through a room when the bed sits in one). */
export async function hallOfBed(db: Exec, bedId: string): Promise<{ hallId: string; bedName: string; icu: boolean } | null> {
  const bed = (await (db as Db).select().from(resources).where(eq(resources.id, bedId)))[0];
  if (bed === undefined || bed.kind !== "bed" || bed.parentId === null) return null;
  let parent = (await (db as Db).select().from(resources).where(eq(resources.id, bed.parentId)))[0];
  if (parent?.kind === "room" && parent.parentId !== null) parent = (await (db as Db).select().from(resources).where(eq(resources.id, parent.parentId)))[0];
  if (parent === undefined) return null;
  const attrs = (bed.attributes ?? {}) as { icu?: boolean };
  return { hallId: parent.id, bedName: bed.name, icu: attrs.icu === true };
}

/** Where an admission lies now (its open stay), or null when it has no bed. */
export async function placementOf(db: Exec, admissionId: string): Promise<IcuPlacement | null> {
  const a = (await (db as Db).select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined) return null;
  const open = (await (db as Db).select().from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, admissionId), isNull(ipdBedStays.endedAt))))[0];
  if (open === undefined) return null;
  const hall = await hallOfBed(db, open.bedId);
  if (hall === null) return null;
  return {
    admissionId: a.id, patientId: a.patientId, admissionNo: a.admissionNo, consultantId: a.consultantId, department: a.department,
    state: a.state, admittedAt: a.admittedAt, bedId: open.bedId, bedName: hall.bedName, bedClass: open.bedClass, hallId: hall.hallId,
    icuBed: hall.icu,
  };
}

/** A placement on an ICU bed, or the refusal. */
export async function requireIcuPlacement(db: Exec, admissionId: string): Promise<IcuPlacement> {
  const p = await placementOf(db, admissionId);
  if (p === null || !p.icuBed || !(PLACED as readonly string[]).includes(p.state)) throw new IcuError("unknown_admission", { admissionId });
  return p;
}

export async function patientWords(db: Exec, patientId: string): Promise<{ name: string; uhid: string }> {
  const p = (await (db as Db).select({ name: patients.name, alias: patients.alias, uhid: patients.uhid, isConfidential: patients.isConfidential })
    .from(patients).where(eq(patients.id, patientId)))[0];
  if (p === undefined) return { name: "", uhid: "" };
  return { name: p.isConfidential && p.alias !== null ? p.alias : p.name, uhid: p.uhid ?? "" };
}

export const iso = (d: Date | null | undefined): string | null => (d === null || d === undefined ? null : d.toISOString());
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
