import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { STAFF_CREDENTIAL_KEYS, staffCredentials } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { StaffCredentialKey } from "../../kernel/db/schema/roster";

/**
 * PHASE R (R4) — **WHAT SOMEBODY HOLDS, AND UNTIL WHEN.**
 *
 * A ward asks before it lets a person run a resuscitation, a ventilator or a chemotherapy round;
 * an inspector asks to see the register number. Both are the same fact with a validity window on
 * it, and the window is the part that matters: a lapsed ACLS is indistinguishable from no ACLS on
 * the night somebody needs it, and the only way anybody finds out in time is if the roster can say
 * *"this expires inside the month you are about to publish."*
 *
 * ═══ EXPIRY IS A FINDING, NOT A REFUSAL ═══
 *
 * R8's validator raises it. Refusing to roster somebody whose BLS lapses on the 20th would empty a
 * ward on the 21st, which is worse than the thing being prevented. What the hospital needs is to
 * know on the 1st.
 */

export type StaffCredentialRow = typeof staffCredentials.$inferSelect;

export interface RecordCredentialInput {
  userId: string;
  credentialKey: StaffCredentialKey;
  reference: string;
  validFrom: Date;
  validTo?: Date | null;
}

export async function recordCredential(
  tx: Tx, actor: Actor, input: RecordCredentialInput,
): Promise<{ credentialId: string }> {
  await requireRosterAct(tx, actor, "publish");
  if (!(STAFF_CREDENTIAL_KEYS as readonly string[]).includes(input.credentialKey)) {
    throw new RosterError("unknown_credential", `"${input.credentialKey}" is not a registration or certificate this hospital records`, { credentialKey: input.credentialKey });
  }
  const reference = input.reference.trim();
  if (reference === "" || reference.length > 120) {
    throw new RosterError("invalid_window", "a registration or certificate needs its number, in 120 characters or fewer", { referenceLength: reference.length });
  }
  if (input.validTo != null && input.validTo <= input.validFrom) {
    throw new RosterError("invalid_window", "a certificate cannot expire before it is issued", {
      validFrom: input.validFrom.toISOString(), validTo: input.validTo.toISOString(),
    });
  }
  const person = (await (tx as Db).select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.userId)))[0];
  if (person === undefined || !person.active) throw new RosterError("unknown_user", undefined, { userId: input.userId });

  const credentialId = newId();
  await tx.insert(staffCredentials).values({
    id: credentialId, userId: input.userId, credentialKey: input.credentialKey, reference,
    validFrom: input.validFrom, validTo: input.validTo ?? null,
    createdBy: actor.id, updatedBy: actor.id,
  });
  return { credentialId };
}

/**
 * Somebody has SEEN the certificate. Deliberately a separate act from recording it: a clerk types
 * the number from a form, and the office that checks it against the council's register is not the
 * same desk. A requirement that names a credential (R8) can then ask for a VERIFIED one.
 */
export async function verifyCredential(tx: Tx, actor: Actor, credentialId: string): Promise<void> {
  await requireRosterAct(tx, actor, "publish");
  const row = (await tx.select().from(staffCredentials).where(eq(staffCredentials.id, credentialId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_credential", undefined, { credentialId });
  const r = await tx.execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  const now = raw instanceof Date ? raw : new Date(String(raw));
  await tx.update(staffCredentials)
    .set({ verifiedBy: actor.id, verifiedAt: now, updatedBy: actor.id, updatedAt: now })
    .where(eq(staffCredentials.id, credentialId));
}

/** What this person holds at `at` — live windows only. */
export async function credentialsOf(exec: Db | Tx, userId: string, at: Date): Promise<StaffCredentialRow[]> {
  return (exec as Db).select().from(staffCredentials)
    .where(and(
      eq(staffCredentials.userId, userId),
      sql`${staffCredentials.validFrom} <= ${at}`,
      or(isNull(staffCredentials.validTo), sql`${staffCredentials.validTo} > ${at}`),
    ))
    .orderBy(asc(staffCredentials.credentialKey));
}

export async function holdsCredential(
  exec: Db | Tx, userId: string, credentialKey: StaffCredentialKey, at: Date,
  opts: { verifiedOnly?: boolean } = {},
): Promise<boolean> {
  const held = await credentialsOf(exec, userId, at);
  return held.some((c) => c.credentialKey === credentialKey
    && (opts.verifiedOnly !== true || c.verifiedAt !== null));
}

/**
 * Everything that lapses inside `[from, to)` — the question a head asks before publishing a month.
 * A credential with no `valid_to` never expires and never appears here.
 */
export async function expiringCredentials(
  exec: Db | Tx, from: Date, to: Date,
): Promise<StaffCredentialRow[]> {
  return (exec as Db).select().from(staffCredentials)
    .where(and(
      sql`${staffCredentials.validTo} is not null`,
      sql`${staffCredentials.validTo} >= ${from}`,
      sql`${staffCredentials.validTo} < ${to}`,
    ))
    .orderBy(asc(staffCredentials.validTo), asc(staffCredentials.userId));
}
