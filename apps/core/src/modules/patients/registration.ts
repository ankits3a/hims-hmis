import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { patientGuardians, patients } from "../../kernel/db/schema";
import { allocateUhid, PatientError } from "./uhid";
import { guardianLinked, patientRegistered, patientUpdated } from "./events";
import { MAJORITY_AGE_YEARS, yearsBetween } from "./types";
import type {
  AbhaVerificationStatus, BloodGroup, GuardianRelationship, PatientLanguage, Sex,
} from "./types";
import type { Db, Tx } from "../../kernel/db/client";

export type PatientRow = typeof patients.$inferSelect;

export type GuardianInput = {
  name: string;
  phone?: string;
  relationship: GuardianRelationship;
  idType?: "aadhaar" | "pan" | "voter_id" | "other";
  idNumberMasked?: string; // last-4 only — the schema never holds a full document number
  idVerified?: boolean;
  authorityMessages?: boolean;
  authorityConsents?: boolean;
  authorityDsr?: boolean;
  authorityBills?: boolean;
  consentNote?: string;
};

export type RegisterPatientInput = {
  name: string;
  phone?: string;
  altPhone?: string;
  dob?: Date;
  ageYears?: number;
  sex: Sex;
  addressLine?: string;
  district?: string;
  stateName?: string;
  pincode?: string;
  language?: PatientLanguage;
  bloodGroup?: BloodGroup;
  isConfidential?: boolean;
  alias?: string;
  sensitiveContext?: boolean;
  abhaAddress?: string;
  abhaNumber?: string;
  abhaVerificationStatus?: AbhaVerificationStatus;
  legacyUhid?: string;
  guardian?: GuardianInput;
  promotionalOptIn?: boolean; // D9: DPDP consent, captured at registration — default false (opt-IN means the patient acted)
};

/** Registers a patient on the caller's transaction. Rules in order, each separately tested. */
export async function registerPatient(
  tx: Tx,
  actor: Actor,
  input: RegisterPatientInput,
): Promise<{ patient: PatientRow; guardianId: string | null }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only user actors register patients");
  }
  if (input.dob !== undefined && input.ageYears !== undefined) {
    throw new PatientError("dob_or_age", "provide dob OR ageYears, not both");
  }
  let dob = input.dob ?? null;
  let dobEstimated = false;
  if (input.ageYears !== undefined) {
    const now = new Date();
    dob = new Date(Date.UTC(now.getUTCFullYear() - input.ageYears, now.getUTCMonth(), now.getUTCDate()));
    dobEstimated = true;
  }
  const isConfidential = input.isConfidential ?? false;
  if (isConfidential && (input.alias ?? "").trim() === "") {
    throw new PatientError("alias_required", "a confidential patient needs an alias for public surfaces (§14)");
  }
  // D-31 + DPDP §9: a KNOWN minor must have a guardian at registration. Unknown DOB cannot
  // be enforced against — the desk flow prompts, the rule binds only on data it has.
  const minor = dob !== null && yearsBetween(dob, new Date()) < MAJORITY_AGE_YEARS;
  if (minor && input.guardian === undefined) {
    throw new PatientError("minor_needs_guardian", "a minor's registration must include a guardian (D-31, DPDP §9)");
  }

  const patientId = newId();
  const uhid = await allocateUhid(tx);
  const inserted = await tx
    .insert(patients)
    .values({
      id: patientId,
      uhid,
      name: input.name,
      phone: input.phone ?? null,
      altPhone: input.altPhone ?? null,
      dob,
      dobEstimated,
      sex: input.sex,
      addressLine: input.addressLine ?? null,
      district: input.district ?? null,
      stateName: input.stateName ?? null,
      pincode: input.pincode ?? null,
      language: input.language ?? "hi",
      bloodGroup: input.bloodGroup ?? null,
      isConfidential,
      alias: input.alias ?? null,
      sensitiveContext: input.sensitiveContext ?? false,
      abhaAddress: input.abhaAddress ?? null,
      abhaNumber: input.abhaNumber ?? null,
      abhaVerificationStatus: input.abhaVerificationStatus ?? "none",
      legacyUhid: input.legacyUhid ?? null,
      promotionalOptIn: input.promotionalOptIn ?? false,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .returning();
  const patient = inserted[0]!;

  let guardianId: string | null = null;
  if (input.guardian !== undefined) {
    const g = input.guardian;
    guardianId = newId();
    await tx.insert(patientGuardians).values({
      id: guardianId,
      patientId,
      name: g.name,
      phone: g.phone ?? null,
      relationship: g.relationship,
      idType: g.idType ?? null,
      idNumberMasked: g.idNumberMasked ?? null,
      idVerified: g.idVerified ?? false,
      authorityMessages: g.authorityMessages ?? true,
      authorityConsents: g.authorityConsents ?? true,
      authorityDsr: g.authorityDsr ?? false,
      authorityBills: g.authorityBills ?? true,
      consentNote: g.consentNote ?? null,
      createdBy: actor.id,
    });
  }

  await appendEvent(
    tx,
    patientRegistered.make({
      actor,
      patientId,
      payload: { patientId, uhid, name: patient.name, phone: patient.phone, language: patient.language },
    }),
  );
  if (guardianId !== null) {
    const g = input.guardian!;
    await appendEvent(
      tx,
      guardianLinked.make({
        actor,
        patientId,
        payload: {
          patientId,
          guardianId,
          relationship: g.relationship,
          authority: {
            messages: g.authorityMessages ?? true,
            consents: g.authorityConsents ?? true,
            dsr: g.authorityDsr ?? false,
            bills: g.authorityBills ?? true,
          },
        },
      }),
    );
  }
  return { patient, guardianId };
}

/** The patchable surface. uhid / qrVersion / status / mergedIntoPatientId are structurally absent. */
export type PatientPatch = Partial<{
  name: string;
  phone: string | null;
  altPhone: string | null;
  dob: Date | null;
  dobEstimated: boolean;
  sex: Sex;
  addressLine: string | null;
  district: string | null;
  stateName: string | null;
  pincode: string | null;
  language: PatientLanguage;
  bloodGroup: BloodGroup | null;
  isConfidential: boolean;
  alias: string | null;
  sensitiveContext: boolean;
  abhaAddress: string | null;
  abhaNumber: string | null;
  abhaVerificationStatus: AbhaVerificationStatus;
  abhaLinkToken: string | null;
  legacyUhid: string | null;
  promotionalOptIn: boolean; // D9: revocable on the patient record — this PATCH is the revocation path
  deceasedAt: string | null; // D10 (D-33): ISO datetime; the hard stop the notifications gateway reads at send time
}>;

const PATCHABLE = [
  "name", "phone", "altPhone", "dob", "dobEstimated", "sex", "addressLine", "district",
  "stateName", "pincode", "language", "bloodGroup", "isConfidential", "alias",
  "sensitiveContext", "abhaAddress", "abhaNumber", "abhaVerificationStatus",
  "abhaLinkToken", "legacyUhid", "promotionalOptIn", "deceasedAt",
] as const;

function asAuditString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * deceasedAt is a TIMESTAMP (unlike dob, a date-only column) — asAuditString's date-only
 * truncation would make two different same-day instants compare equal and silently skip both
 * the audit entry and the DB write for a genuine change to this D-33 hard-stop column. Diffed
 * at full ISO precision instead, on both sides (the current row's Date and the patch's string).
 */
function asAuditTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function updatePatient(
  tx: Tx,
  actor: Actor,
  patientId: string,
  patch: PatientPatch,
): Promise<{ patient: PatientRow; changed: string[] }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only user actors update patients");
  }
  const rows = await tx.select().from(patients).where(eq(patients.id, patientId));
  const current = rows[0];
  if (!current) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (current.status !== "active") {
    throw new PatientError("patient_not_active", "a merged record is frozen — edit the canonical patient");
  }

  const changes: { field: string; from: string | null; to: string | null }[] = [];
  const set: Record<string, unknown> = {};
  for (const field of PATCHABLE) {
    if (!(field in patch)) continue;
    let next = (patch as Record<string, unknown>)[field];
    // deceasedAt arrives as a validated ISO string (patients.controller.ts's z.string().datetime());
    // the column is a real Date, so it is converted here — once — before diffing and before the set.
    if (field === "deceasedAt" && typeof next === "string") next = new Date(next);
    const prev = (current as Record<string, unknown>)[field];
    const prevS = field === "deceasedAt" ? asAuditTimestamp(prev) : asAuditString(prev);
    const nextS = field === "deceasedAt" ? asAuditTimestamp(next) : asAuditString(next);
    if (prevS === nextS) continue;
    changes.push({ field, from: prevS, to: nextS });
    set[field] = next ?? null;
  }
  if (changes.length === 0) return { patient: current, changed: [] };

  const resultingConfidential = (set.isConfidential as boolean | undefined) ?? current.isConfidential;
  const resultingAlias = "alias" in set ? (set.alias as string | null) : current.alias;
  if (resultingConfidential && (resultingAlias ?? "").trim() === "") {
    throw new PatientError("alias_required", "a confidential patient needs an alias (§14)");
  }

  const updated = await tx
    .update(patients)
    .set({ ...set, updatedBy: actor.id, updatedAt: new Date() })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
    .returning();
  if (updated.length === 0) {
    // Lost a race against a merge freeze between the read and the write.
    throw new PatientError("patient_not_active", "patient was frozen concurrently");
  }
  await appendEvent(
    tx,
    patientUpdated.make({ actor, patientId, payload: { patientId, changes } }),
  );
  return { patient: updated[0]!, changed: changes.map((c) => c.field) };
}

const MERGE_CHAIN_MAX_HOPS = 5;

async function followMergeChain(
  db: Db,
  patientId: string,
): Promise<{ row: PatientRow; resolvedFrom: string | null } | null> {
  let currentId = patientId;
  for (let hop = 0; hop <= MERGE_CHAIN_MAX_HOPS; hop++) {
    const rows = await db.select().from(patients).where(eq(patients.id, currentId));
    const row = rows[0];
    if (!row) return null;
    if (row.status !== "merged" || row.mergedIntoPatientId === null) {
      return { row, resolvedFrom: currentId === patientId ? null : patientId };
    }
    currentId = row.mergedIntoPatientId;
  }
  throw new Error(`merge chain deeper than ${MERGE_CHAIN_MAX_HOPS} hops from ${patientId} — data corruption, investigate`);
}

/**
 * Chain-resolving read with the §14 confidential gate: flagged patients are existence-hidden
 * (null, indistinguishable from not-found) from user actors without patients.confidential.read
 * and from agent actors (Plan 12 seam). system actors pass — internal machinery must resolve.
 * D-37: the flag gates VISIBILITY only; nothing anywhere orders or prioritizes on it.
 */
export async function getPatient(
  db: Db,
  actor: Actor,
  patientId: string,
): Promise<{ patient: PatientRow; resolvedFrom: string | null } | null> {
  const resolved = await followMergeChain(db, patientId);
  if (!resolved) return null;
  if (resolved.row.isConfidential && actor.type !== "system") {
    if (actor.type === "agent") return null;
    const allowed = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
    if (!allowed) return null;
  }
  return { patient: resolved.row, resolvedFrom: resolved.resolvedFrom };
}

/** Id mapping only — no demographics, no gate (§6: later modules resolve ids, they never copy data). */
export async function resolvePatientId(db: Db, patientId: string): Promise<string | null> {
  const resolved = await followMergeChain(db, patientId);
  return resolved ? resolved.row.id : null;
}

/**
 * Plan 07 bulk display summaries for queue/desk surfaces. Each requested id is resolved through the merge chain
 * (requestedId is echoed so callers can re-key). Confidential rows return alias + restricted:true — never the name —
 * unless the caller may see them (the verifyQrScan precedent); uhid/sex/dob are returned regardless because the staff
 * physically serving the patient need them (§14 privacy surface; D-37: nothing prioritises on any of this).
 */
export type PatientSummary = {
  requestedId: string; id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean; sex: string; dob: Date | null;
};

export async function getPatientSummaries(db: Db, actor: Actor, patientIds: string[]): Promise<PatientSummary[]> {
  const unique = [...new Set(patientIds)];
  if (unique.length === 0) return [];
  // ONE query for the common case; only rows that are themselves merged losers walk the chain (rare).
  const rows = await db.select().from(patients).where(inArray(patients.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: PatientSummary[] = [];
  let canSee: boolean | null = null; // resolved at most once per call
  for (const requestedId of unique) {
    let row = byId.get(requestedId);
    if (row !== undefined && row.status === "merged") row = (await followMergeChain(db, requestedId))?.row;
    if (row === undefined) continue;
    let restricted = false;
    if (row.isConfidential && actor.type !== "system") {
      if (canSee === null) {
        canSee = actor.type === "user" ? await hasPermission(db, actor.id, "patients.confidential.read", "hospital") : false;
      }
      restricted = !canSee;
    }
    out.push({
      requestedId, id: row.id, uhid: row.uhid,
      name: restricted ? null : row.name, alias: restricted ? row.alias : null, restricted, sex: row.sex, dob: row.dob,
    });
  }
  return out;
}

/**
 * Every patient id whose merge chain ends at winnerId, excluding the winner (depth-capped at 5 hops like followMergeChain).
 * Consumers that keep their own patient_id (Plan 07 encounters) assemble a merged patient's full history with it —
 * merge never rewrites other modules' rows (§6).
 */
export async function listMergedLoserIds(db: Db, winnerId: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [winnerId];
  for (let hop = 0; hop < 5 && frontier.length > 0; hop++) {
    const rows = await db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.status, "merged"), inArray(patients.mergedIntoPatientId, frontier)));
    frontier = rows.map((r) => r.id).filter((id) => !found.includes(id));
    found.push(...frontier);
  }
  return found;
}
