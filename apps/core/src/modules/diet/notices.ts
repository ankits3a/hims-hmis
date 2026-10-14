import { and, eq, inArray } from "drizzle-orm";
import { DIET_TASK_KINDS } from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { roleAssignments, rolePermissions, users } from "../../kernel/db/schema";
import { nowIdentities } from "../ipd";
import { raiseTask } from "../tasks";
import "./kinds";
import { DIET_ACTOR, DIET_KITCHEN, DIET_NPO, DIET_SERVE } from "./names";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ TELLING THE WARD AND THE KITCHEN ═══
 *
 * The printed paper must never be stale (DECIDED, review of 01d53113). A change to a printed list tells:
 *   · the WARD — a `diet_ward_notice` task on the ward (its attendants, skill `diet_ward`) whose note names the bed and
 *     the patient (the alias for a sealed or confidential patient: identities are read as a reader with no clinical
 *     permission), AND a bell to every person who holds `diet.npo` or `diet.serve` (the nurses and the dietician);
 *   · the KITCHEN — a bell to every person who holds `diet.kitchen`.
 * Bells carry ward, bed and meal only — never a patient (GC6, `kernel/alerts/notices.ts`): a bell reaches the phone.
 * INTEGRATION: until ward assignments exist, "the ward's nurses" means every holder of the permission.
 */
const NOTICE_READER: Actor = { type: "user", id: "diet-notice-reader" };

/** Active users holding any of the permissions at hospital scope. */
export async function holdersOf(tx: Tx, permissions: readonly string[]): Promise<string[]> {
  const rows = await tx.select({ userId: roleAssignments.userId }).from(roleAssignments)
    .innerJoin(rolePermissions, eq(rolePermissions.roleKey, roleAssignments.roleKey))
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(inArray(rolePermissions.permission, [...permissions]), eq(users.active, true), eq(roleAssignments.scopeType, "hospital")));
  return [...new Set(rows.map((r) => r.userId))].sort();
}

export type DietChange = {
  wardId: string; wardName: string; bedCode: string | null; admissionId: string; patientId: string;
  meal: string; words: string; key: string;
};

/** The patient as a ward notice may name them: alias when sealed or confidential. */
export async function noticeName(tx: Tx, admissionId: string, patientId: string): Promise<string> {
  const id = (await nowIdentities(tx as unknown as Db, NOTICE_READER, [{ id: admissionId, patientId }])).get(admissionId);
  return id?.name ?? "patient";
}

export async function tellWardAndKitchen(tx: Tx, c: DietChange, now: Date): Promise<void> {
  const who = await noticeName(tx, c.admissionId, c.patientId);
  const bed = c.bedCode ?? "?";
  await raiseTask(tx, DIET_ACTOR, {
    kind: DIET_TASK_KINDS.wardNotice, placeResourceId: c.wardId, patientId: c.patientId, priority: "urgent",
    note: `Bed ${bed} · ${who} · ${c.meal}: ${c.words}`.slice(0, 280), sourceRef: `diet-notice:${c.key}`.slice(0, 128),
  }, now);
  const title = `Diet change · ${c.wardName} bed ${bed}`;
  const body = `${c.meal}: ${c.words}`;
  for (const userId of await holdersOf(tx, [DIET_NPO, DIET_SERVE])) {
    await raiseNoticeIn(tx, { userId, kind: "diet.ward_change", title, body, refType: "ward", refId: c.wardId, sourceKey: `diet-ward:${c.key}`, at: now });
  }
  for (const userId of await holdersOf(tx, [DIET_KITCHEN])) {
    await raiseNoticeIn(tx, { userId, kind: "diet.kitchen_change", title, body, refType: "ward", refId: c.wardId, sourceKey: `diet-kitchen:${c.key}`, at: now });
  }
}

/** A message to the kitchen alone (a meal whose list the clock missed). */
export async function tellKitchen(tx: Tx, title: string, body: string, refId: string, sourceKey: string, now: Date): Promise<number> {
  let n = 0;
  for (const userId of await holdersOf(tx, [DIET_KITCHEN])) {
    if (await raiseNoticeIn(tx, { userId, kind: "diet.list_missed", title, body, refType: "diet_meal", refId, sourceKey, at: now })) n += 1;
  }
  return n;
}
