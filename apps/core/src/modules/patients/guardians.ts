import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { patientGuardians, patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { guardianAuthorityChanged, guardianLinked } from "./events";
import { MAJORITY_AGE_YEARS, yearsBetween } from "./types";
import { PatientError } from "./uhid";
import type { GuardianInput, PatientRow } from "./registration";
import type { Db, Tx } from "../../kernel/db/client";

export type GuardianRow = typeof patientGuardians.$inferSelect;
export type GuardianAuthority = { messages: boolean; consents: boolean; dsr: boolean; bills: boolean };
export const NO_AUTHORITY: GuardianAuthority = { messages: false, consents: false, dsr: false, bills: false };

/**
 * THE enforcement point (owner decision Q4 — the Plan 02 temp-roles pattern): every consumer
 * computes authority from this pure function at read time. A guardian of an 18-year-old is
 * powerless the instant the birthday passes, whether or not the sweep has run. The D-31
 * sensitive-context override seals ONLY the message channel: POCSO/abuse/adolescent-
 * confidentiality flags must route messages away from the default guardian number, while
 * consent/bill authority is a distinct legal question left to the stored flags.
 */
export function effectiveGuardianAuthority(
  patient: PatientRow,
  guardian: GuardianRow,
  now: Date = new Date(),
): GuardianAuthority {
  if (guardian.status !== "active") return NO_AUTHORITY;
  if (guardian.validTo !== null && guardian.validTo.getTime() <= now.getTime()) return NO_AUTHORITY;
  if (patient.dob !== null && yearsBetween(patient.dob, now) >= MAJORITY_AGE_YEARS) return NO_AUTHORITY;
  return {
    messages: patient.sensitiveContext ? false : guardian.authorityMessages,
    consents: guardian.authorityConsents,
    dsr: guardian.authorityDsr,
    bills: guardian.authorityBills,
  };
}

export async function linkGuardian(
  tx: Tx,
  actor: Actor,
  patientId: string,
  input: GuardianInput,
): Promise<{ guardianId: string }> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select({ status: patients.status }).from(patients).where(eq(patients.id, patientId));
  if (rows.length === 0) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (rows[0]!.status !== "active") throw new PatientError("patient_not_active", "link guardians on the canonical patient");

  const guardianId = newId();
  await tx.insert(patientGuardians).values({
    id: guardianId,
    patientId,
    name: input.name,
    phone: input.phone ?? null,
    relationship: input.relationship,
    idType: input.idType ?? null,
    idNumberMasked: input.idNumberMasked ?? null,
    idVerified: input.idVerified ?? false,
    authorityMessages: input.authorityMessages ?? true,
    authorityConsents: input.authorityConsents ?? true,
    authorityDsr: input.authorityDsr ?? false,
    authorityBills: input.authorityBills ?? true,
    consentNote: input.consentNote ?? null,
    createdBy: actor.id,
  });
  await appendEvent(
    tx,
    guardianLinked.make({
      actor,
      patientId,
      payload: {
        patientId,
        guardianId,
        relationship: input.relationship,
        authority: {
          messages: input.authorityMessages ?? true,
          consents: input.authorityConsents ?? true,
          dsr: input.authorityDsr ?? false,
          bills: input.authorityBills ?? true,
        },
      },
    }),
  );
  return { guardianId };
}

export async function updateGuardianAuthority(
  tx: Tx,
  actor: Actor,
  guardianId: string,
  patch: Partial<GuardianAuthority> & {
    phone?: string | null;
    idVerified?: boolean;
    validTo?: Date | null;
    consentNote?: string | null;
  },
): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select().from(patientGuardians).where(eq(patientGuardians.id, guardianId));
  const guardian = rows[0];
  if (!guardian) throw new PatientError("guardian_not_found", `unknown guardian ${guardianId}`);
  if (guardian.status !== "active") throw new PatientError("guardian_not_active");

  const set: Record<string, unknown> = {};
  if (patch.messages !== undefined) set.authorityMessages = patch.messages;
  if (patch.consents !== undefined) set.authorityConsents = patch.consents;
  if (patch.dsr !== undefined) set.authorityDsr = patch.dsr;
  if (patch.bills !== undefined) set.authorityBills = patch.bills;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.idVerified !== undefined) set.idVerified = patch.idVerified;
  if (patch.validTo !== undefined) set.validTo = patch.validTo;
  if (patch.consentNote !== undefined) set.consentNote = patch.consentNote;
  if (Object.keys(set).length === 0) return;

  const updated = await tx
    .update(patientGuardians)
    .set(set)
    .where(and(eq(patientGuardians.id, guardianId), eq(patientGuardians.status, "active")))
    .returning();
  if (updated.length === 0) throw new PatientError("guardian_not_active", "guardian changed concurrently");

  const patientRows = await tx.select().from(patients).where(eq(patients.id, guardian.patientId));
  await appendEvent(
    tx,
    guardianAuthorityChanged.make({
      actor,
      patientId: guardian.patientId,
      payload: {
        patientId: guardian.patientId,
        guardianId,
        reason: "update",
        authority: effectiveGuardianAuthority(patientRows[0]!, updated[0]!),
      },
    }),
  );
}

export async function endGuardian(tx: Tx, actor: Actor, guardianId: string): Promise<void> {
  if (actor.type !== "user") throw new PatientError("user_actor_required");
  const rows = await tx.select({ patientId: patientGuardians.patientId }).from(patientGuardians).where(eq(patientGuardians.id, guardianId));
  if (rows.length === 0) throw new PatientError("guardian_not_found", `unknown guardian ${guardianId}`);

  const updated = await tx
    .update(patientGuardians)
    .set({ status: "ended", endedBy: actor.id, endedAt: new Date() })
    .where(and(eq(patientGuardians.id, guardianId), eq(patientGuardians.status, "active")))
    .returning({ id: patientGuardians.id });
  if (updated.length === 0) throw new PatientError("guardian_not_active", "already ended");

  await appendEvent(
    tx,
    guardianAuthorityChanged.make({
      actor,
      patientId: rows[0]!.patientId,
      payload: { patientId: rows[0]!.patientId, guardianId, reason: "ended", authority: NO_AUTHORITY },
    }),
  );
}

/**
 * The FOURTH unscheduled sweep (owner decision 2026-08-13 Q4), alongside runDispatchCycle,
 * sweepExpiredTempRoles, and runDueTimers — Plan 11 registers all four as pg-boss crons.
 * Correctness never depends on it (effectiveGuardianAuthority above); this flips row status
 * and emits guardian.authority_changed for downstream consumers (Plan 10 routing, reports).
 * Concurrency: the status='active' predicate re-evaluates under READ COMMITTED, so two
 * racing sweeps split the claimed rows — proven by the parallel test.
 */
export async function sweepGuardianMajority(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - MAJORITY_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()));
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return withTx(db, async (tx) => {
    const claimed = await tx.execute(sql`
      update patient_guardians pg
      set status = 'majority_ended', ended_at = now()
      from patients p
      where pg.patient_id = p.id
        and pg.status = 'active'
        and p.dob is not null
        and p.dob <= ${cutoffIso}::date
      returning pg.id as guardian_id, pg.patient_id as patient_id
    `);
    for (const row of claimed.rows) {
      const guardianId = String(row.guardian_id);
      const patientId = String(row.patient_id);
      await appendEvent(
        tx,
        guardianAuthorityChanged.make({
          actor: { type: "system", id: "guardian-majority-sweep" },
          patientId,
          payload: { patientId, guardianId, reason: "majority", authority: NO_AUTHORITY },
        }),
      );
    }
    return claimed.rows.length;
  });
}
