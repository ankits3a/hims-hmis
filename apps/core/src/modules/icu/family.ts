import { and, desc, eq } from "drizzle-orm";
import { icuFamilyUpdateInput, icuVisitInput, newId } from "@hmis/contracts";
import { icuFamilyUpdates, icuVisitSlots } from "../../kernel/db/schema";
import { registerFamilyTodayProvider } from "../ipd";
import { istDay, parse, requireIcuPlacement, requirePermission } from "./common";
import { ICU_CARE } from "./permissions";
import type { Actor, IcuFamilyToday } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ICU IC-1 (#984, D9) — VISITING SLOTS AND THE DAILY FAMILY UPDATE, both logged with who and when. The family link
 * (ipd's public page) shows TODAY's latest update in words through `registerFamilyTodayProvider` — never a number from a
 * monitor: the provider reads `icu_family_updates` only, and the page has no field for a vital sign.
 */

export async function logVisit(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ visitId: string }> {
  const input = parse(icuVisitInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  await requireIcuPlacement(db, input.admissionId);
  const visitId = newId();
  await db.insert(icuVisitSlots).values({
    id: visitId, admissionId: input.admissionId, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt),
    visitorName: input.visitorName, relation: input.relation, loggedBy: actor.id, loggedAt: now,
  });
  return { visitId };
}

export async function logFamilyUpdate(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ updateId: string }> {
  const input = parse(icuFamilyUpdateInput, raw);
  await requirePermission(db, actor, ICU_CARE);
  await requireIcuPlacement(db, input.admissionId);
  const updateId = newId();
  await db.insert(icuFamilyUpdates).values({
    id: updateId, admissionId: input.admissionId, istDay: istDay(now), summary: input.summary, givenTo: input.givenTo,
    relation: input.relation, mode: input.mode, givenBy: actor.id, givenAt: now,
  });
  return { updateId };
}

/** Today's (IST) latest update in words, or null. */
export async function familyToday(db: Db, admissionId: string, at: Date): Promise<IcuFamilyToday | null> {
  const row = (await db.select().from(icuFamilyUpdates)
    .where(and(eq(icuFamilyUpdates.admissionId, admissionId), eq(icuFamilyUpdates.istDay, istDay(at))))
    .orderBy(desc(icuFamilyUpdates.givenAt)).limit(1))[0];
  if (row === undefined || row.givenAt > at) return null;
  return { summary: row.summary, at: row.givenAt.toISOString(), mode: row.mode };
}

/** Installed when the module is loaded (index.ts): ipd's family page asks it for "today's update". */
export function installFamilyToday(): () => void {
  return registerFamilyTodayProvider((db, admissionId, at) => familyToday(db, admissionId, at));
}
