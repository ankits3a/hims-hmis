import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { registrationConfig } from "../../kernel/db/schema";
import type { Tx } from "../../kernel/db/client";

/**
 * One error class for the whole patients module (the Plan 03/04 one-class convention).
 * Defined here — the module's lowest layer — and re-exported by types.ts; the union carries
 * every code T3–T8 throw so no later task edits this file.
 */
export type PatientErrorCode =
  | "user_actor_required"
  | "registration_not_configured"
  | "patient_not_found"
  | "patient_not_active"
  | "reason_required"
  | "alias_required"
  | "dob_or_age"
  | "minor_needs_guardian"
  | "photo_too_large"
  | "unsupported_photo_type"
  | "allergy_not_found"
  | "allergy_not_active"
  | "guardian_not_found"
  | "guardian_not_active"
  | "merge_same_patient"
  | "merge_already_requested"
  | "unknown_merge_request"
  | "merge_not_requested"
  | "merge_not_executed"
  | "approval_not_granted"
  | "unmerge_not_requested"
  | "unmerge_already_requested";

export class PatientError extends Error {
  constructor(
    readonly code: PatientErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PatientError";
  }
}

// Verhoeff (owner decision Q6 — Aadhaar's algorithm): detects all single-digit errors and
// all adjacent transpositions. Tables are the published dihedral-group D5 tables; the
// property tests (every substitution, every transposition) would fail on ANY transcription
// error, so correctness is proven by execution, not by trusting these literals.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

/** Check digit for a digit string (throws on non-digits — internal misuse, not user input). */
export function verhoeffCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error(`verhoeffCheckDigit: non-digit input "${digits}"`);
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c]![P[(i + 1) % 8]![Number(reversed[i])]!]!;
  }
  return INV[c]!;
}

function verhoeffValidates(digitsWithCheck: string): boolean {
  let c = 0;
  const reversed = digitsWithCheck.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c]![P[i % 8]![Number(reversed[i])]!]!;
  }
  return c === 0;
}

const UHID_RE = /^([A-Z]{2,5})-(\d{8})-(\d)$/;

export function isValidUhid(uhid: string): boolean {
  const m = UHID_RE.exec(uhid);
  if (!m) return false;
  return verhoeffValidates(m[2]! + m[3]!);
}

export function formatUhid(prefix: string, n: number): string {
  const body = String(n).padStart(8, "0");
  return `${prefix}-${body}-${verhoeffCheckDigit(body)}`;
}

/** Allocates the next UHID on the caller's transaction. Sequence = concurrency-safe by construction. */
export async function allocateUhid(tx: Tx): Promise<string> {
  const cfg = await tx
    .select({ uhidPrefix: registrationConfig.uhidPrefix })
    .from(registrationConfig)
    .where(eq(registrationConfig.id, "main"));
  if (cfg.length === 0) {
    throw new PatientError(
      "registration_not_configured",
      "registration_config row 'main' is missing — run: UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration",
    );
  }
  const res = await tx.execute(sql`select nextval('uhid_seq') as n`);
  const n = Number(res.rows[0]!.n); // nextval returns bigint → TEXT through pg; force a real number
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`uhid_seq returned unusable value: ${String(res.rows[0]!.n)}`);
  return formatUhid(cfg[0]!.uhidPrefix, n);
}
