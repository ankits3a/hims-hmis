import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { pharmacyPharmacistRegistrations, users } from "../../kernel/db/schema";
import { usersHoldingRoleAtScope } from "../../kernel/workflow/roles";
import { withTx } from "../../kernel/db/client";
import { REGISTRATION_RENEWAL_NOTICE_DAYS, istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { pharmacistRegistered, pharmacistRegistrationEnded } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P2 — THE REGISTER OF PHARMACISTS ═══
 *
 * The Pharmacy Act 1948 §42 reserves dispensing to a registered pharmacist. A role says what a login
 * may touch; this register says whether the person behind it holds a state pharmacy council
 * registration today. Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p2-pharmacist-register.md`.
 *
 * Three acts, and the rules each one keeps:
 *   - `recordPharmacistRegistration`: files a certificate for SOMEONE ELSE who holds `pharmacy`. A
 *     renewal ends the current row in the same transaction; a row is never edited.
 *   - `endPharmacistRegistration`: ends a current row with a reason. Not one's own either.
 *   - `requireRegisteredPharmacist`: the gate the Act's acts call (verify; a scheduled hand-over).
 */
export const PHARMACIST_ROLE = "pharmacy";

export type PharmacistRegistration = {
  id: string;
  userId: string;
  council: string;
  registrationNo: string;
  validUntil: string | null;
  recordedBy: string;
  recordedAt: Date;
  endedAt: Date | null;
  endedBy: string | null;
  endReason: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function personOf(actor: Actor): string {
  if (actor.type !== "user") {
    throw new PharmacyError("permission_denied", `a ${actor.type} actor may not act on the register of pharmacists`);
  }
  return actor.id;
}

/** Current = not ended, and not past its `valid_until` on the IST date `today`. */
export async function currentRegistration(db: Db | Tx, userId: string, today: string): Promise<PharmacistRegistration | null> {
  const rows = await db.select().from(pharmacyPharmacistRegistrations).where(and(
    eq(pharmacyPharmacistRegistrations.userId, userId),
    isNull(pharmacyPharmacistRegistrations.endedAt),
    sql`(${pharmacyPharmacistRegistrations.validUntil} is null or ${pharmacyPharmacistRegistrations.validUntil} >= ${today}::date)`,
  ));
  return rows[0] ?? null;
}

/**
 * The desk header's "registered · PCI <no>": the ACTING person's own current registration, or null —
 * a read, never a gate (the gate is `requireRegisteredPharmacist`, at the acts the Act reserves).
 */
export async function myRegistration(db: Db | Tx, actor: Actor, now: Date): Promise<Pick<PharmacistRegistration, "council" | "registrationNo" | "validUntil"> | null> {
  if (actor.type !== "user") return null;
  const reg = await currentRegistration(db, actor.id, istDateOf(now));
  return reg === null ? null : { council: reg.council, registrationNo: reg.registrationNo, validUntil: reg.validUntil };
}

/**
 * THE GATE. The acts the Act reserves call this with the acting person: a login without a current
 * registration is refused, whatever role it holds. Returns the registration so the caller can put
 * its number on the record it writes.
 */
export async function requireRegisteredPharmacist(db: Db | Tx, actor: Actor, now: Date): Promise<PharmacistRegistration> {
  const userId = personOf(actor);
  const reg = await currentRegistration(db, userId, istDateOf(now));
  if (reg === null) {
    throw new PharmacyError(
      "pharmacist_not_registered",
      "only a pharmacist with a current state council registration on file may do this — the pharmacist in charge records it at /pharmacy/pharmacists",
      { userId },
    );
  }
  return reg;
}

export async function recordPharmacistRegistration(
  tx: Tx, actor: Actor,
  input: { userId: string; council: string; registrationNo: string; validUntil?: string | null },
  now: Date = new Date(),
): Promise<{ id: string; supersededId: string | null }> {
  const recordedBy = personOf(actor);
  const council = input.council.trim();
  const registrationNo = input.registrationNo.trim();
  const validUntil = input.validUntil ?? null;
  if (input.userId === recordedBy) {
    throw new PharmacyError("self_registration", "a pharmacist's registration is filed by someone else, never by its holder", { userId: input.userId });
  }
  if (council === "" || registrationNo === "" || (validUntil !== null && !DATE.test(validUntil))) {
    throw new PharmacyError("invalid_registration", "a registration names its council, its number and, if it has one, a valid-until date (YYYY-MM-DD)");
  }
  if (validUntil !== null && validUntil < istDateOf(now)) {
    throw new PharmacyError("registration_expired", `this certificate lapsed on ${validUntil} — file the renewed one`, { validUntil });
  }
  const holders = await usersHoldingRoleAtScope(tx, PHARMACIST_ROLE, "hospital");
  if (!holders.includes(input.userId)) {
    throw new PharmacyError("not_a_pharmacist_role", "this person does not hold the pharmacy role — assign it first at /admin/users", { userId: input.userId });
  }
  const clash = await tx.select({ userId: pharmacyPharmacistRegistrations.userId }).from(pharmacyPharmacistRegistrations).where(and(
    isNull(pharmacyPharmacistRegistrations.endedAt),
    sql`lower(${pharmacyPharmacistRegistrations.council}) = lower(${council})`,
    sql`lower(${pharmacyPharmacistRegistrations.registrationNo}) = lower(${registrationNo})`,
  ));
  if (clash.some((c) => c.userId !== input.userId)) {
    throw new PharmacyError("registration_in_use", "that council number is on file for another person — end that row first if it was a mistake", { council, registrationNo });
  }

  // A renewal: the current row (if any) ends in this transaction, so the person is never without one.
  const current = await tx.select({ id: pharmacyPharmacistRegistrations.id }).from(pharmacyPharmacistRegistrations)
    .where(and(eq(pharmacyPharmacistRegistrations.userId, input.userId), isNull(pharmacyPharmacistRegistrations.endedAt)))
    .for("update");
  const supersededId = current[0]?.id ?? null;
  if (supersededId !== null) {
    await tx.update(pharmacyPharmacistRegistrations)
      .set({ endedAt: now, endedBy: recordedBy, endReason: `superseded by ${council} ${registrationNo}` })
      .where(eq(pharmacyPharmacistRegistrations.id, supersededId));
  }
  const id = newId();
  await tx.insert(pharmacyPharmacistRegistrations).values({
    id, userId: input.userId, council, registrationNo, validUntil, recordedBy, recordedAt: now,
  });
  await appendEvent(tx, pharmacistRegistered.make({
    occurredAt: now, actor, correlationId: input.userId,
    payload: { registrationId: id, userId: input.userId, council, registrationNo, validUntil, supersededId },
  }));
  return { id, supersededId };
}

export async function endPharmacistRegistration(
  tx: Tx, actor: Actor, registrationId: string, reason: string, now: Date = new Date(),
): Promise<void> {
  const endedBy = personOf(actor);
  const why = reason.trim();
  if (why.length < 3) throw new PharmacyError("invalid_registration", "ending a registration records why");
  const rows = await tx.select().from(pharmacyPharmacistRegistrations)
    .where(eq(pharmacyPharmacistRegistrations.id, registrationId)).for("update");
  const row = rows[0];
  if (row === undefined) throw new PharmacyError("not_found", `registration ${registrationId} not found`);
  if (row.userId === endedBy) {
    throw new PharmacyError("self_registration", "a pharmacist's registration is ended by someone else, never by its holder", { userId: row.userId });
  }
  if (row.endedAt !== null) throw new PharmacyError("registration_ended", "that registration has already ended", { registrationId });
  await tx.update(pharmacyPharmacistRegistrations)
    .set({ endedAt: now, endedBy, endReason: why })
    .where(and(eq(pharmacyPharmacistRegistrations.id, registrationId), isNull(pharmacyPharmacistRegistrations.endedAt)));
  await appendEvent(tx, pharmacistRegistrationEnded.make({
    occurredAt: now, actor, correlationId: row.userId,
    payload: { registrationId, userId: row.userId, reason: why },
  }));
}

export type PharmacistView = {
  userId: string;
  username: string;
  fullName: string;
  active: boolean;
  /** The registration that lets this person dispense today, or null. */
  current: PharmacistRegistration | null;
  /** P15 — days left on `current` once inside REGISTRATION_RENEWAL_NOTICE_DAYS (0 = its last day); null otherwise. */
  renewalDueInDays: number | null;
  /** Every row on file for the person, newest first: renewals and ended ones included. */
  history: PharmacistRegistration[];
};

/** Everyone who holds `pharmacy`, with what the register says about them — the screen's one read. */
/** P15 — days from `today` to `validUntil` when that is within the renewal notice, else null. */
export function renewalDaysLeft(today: string, validUntil: string): number | null {
  const days = Math.round((Date.parse(`${validUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days >= 0 && days <= REGISTRATION_RENEWAL_NOTICE_DAYS ? days : null;
}

export async function listPharmacists(db: Db, now: Date = new Date()): Promise<PharmacistView[]> {
  const holders = await withTx(db, (tx) => usersHoldingRoleAtScope(tx, PHARMACIST_ROLE, "hospital"));
  if (holders.length === 0) return [];
  const people = await db.select({ id: users.id, username: users.username, fullName: users.fullName, active: users.active })
    .from(users).where(inArray(users.id, holders)).orderBy(asc(users.fullName));
  const rows = await db.select().from(pharmacyPharmacistRegistrations)
    .where(inArray(pharmacyPharmacistRegistrations.userId, holders))
    .orderBy(desc(pharmacyPharmacistRegistrations.recordedAt));
  const today = istDateOf(now);
  return people.map((p) => {
    const history = rows.filter((r) => r.userId === p.id);
    const current = history.find((r) => r.endedAt === null && (r.validUntil === null || r.validUntil >= today)) ?? null;
    const left = current?.validUntil == null ? null : renewalDaysLeft(today, current.validUntil);
    return { userId: p.id, username: p.username, fullName: p.fullName, active: p.active, current, renewalDueInDays: left, history };
  });
}

/**
 * The registration that was current for a person AT a moment: filed by then, not yet ended, not past
 * its date. A label reprinted after a renewal still names the number the dispense was checked under.
 */
export async function registrationAt(db: Db | Tx, userId: string, at: Date): Promise<PharmacistRegistration | null> {
  const rows = await db.select().from(pharmacyPharmacistRegistrations).where(and(
    eq(pharmacyPharmacistRegistrations.userId, userId),
    sql`${pharmacyPharmacistRegistrations.recordedAt} <= ${at}`,
    sql`(${pharmacyPharmacistRegistrations.endedAt} is null or ${pharmacyPharmacistRegistrations.endedAt} > ${at})`,
    sql`(${pharmacyPharmacistRegistrations.validUntil} is null or ${pharmacyPharmacistRegistrations.validUntil} >= ${istDateOf(at)}::date)`,
  )).orderBy(desc(pharmacyPharmacistRegistrations.recordedAt)).limit(1);
  return rows[0] ?? null;
}

/** The person's display name, for a label. */
export async function personName(db: Db | Tx, userId: string): Promise<string | null> {
  const rows = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId));
  return rows[0]?.fullName ?? null;
}

/** The registration number to print or record for a person, if they have a current one. */
export async function registrationNoOf(db: Db | Tx, userId: string, now: Date): Promise<string | null> {
  return (await currentRegistration(db, userId, istDateOf(now)))?.registrationNo ?? null;
}
