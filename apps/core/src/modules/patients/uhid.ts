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
  | "unmerge_already_requested"
  // PLAN 22c-A T3/T5 — the identity spine and the privacy write split.
  | "invalid_assurance"
  | "assurance_not_increasing"
  | "evidence_required"
  | "confidential_write_denied"
  | "deceased_write_denied"
  /**
   * FD-8 — registration now ENDS AT THE UHID, so `POST /patients` is a counter act and must carry
   * the near-match warning the walk-in has always had. A WARNING a human may override, never a gate.
   */
  | "duplicate_suspected";

export class PatientError extends Error {
  constructor(
    readonly code: PatientErrorCode,
    message?: string,
    /**
     * FD-8 — structured payload for the codes whose whole point is what they carry:
     * `duplicate_suspected` is useless without its candidates. `OpdError` has had this since 07b;
     * this is the same shape so a client reads both refusals the same way.
     */
    readonly detail?: unknown,
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

/**
 * THE UHID FORMAT — owner ruling 2026-08-25, REPLACING Plan 05's `<PREFIX>-<8 digits>-<check>`.
 *
 * `U` + a 7-digit serial + a Verhoeff check digit → `U12345013`. Nine characters, no separators.
 *
 * WHY THE HYPHENS WENT. A UHID is typed into a search box far more often than it is read off a
 * card, and `CRK-00000001-7` cost fourteen keystrokes with two of them breaking numeric-keypad
 * flow entirely. The separators carried no information the fixed width did not already carry.
 *
 * WHY THE CHECK DIGIT STAYED (owner ruling, same date — Plan 05's Q6 choice of Verhoeff, kept).
 * It costs one of the nine characters and rejects EVERY single-digit substitution and EVERY
 * adjacent transposition, which is the typo class that would otherwise land a desk on a
 * stranger's chart in a densely-allocated band. The serial paid for it by losing a digit:
 * seven, not eight. Consequence, accepted at the ruling: consecutive registrations no longer
 * READ as consecutive (…013, …021, …032) because the check digit moves independently.
 *
 * ═══ THE FLOOR — OWNER RULING 2026-09-02, LOWERED FROM 1,234,500 TO 11,000 ═══
 *
 *   > "The counter should start with U0011001 and Not CRK1234500."
 *
 * The first issuable serial is now **11,001**, so the first card reads **U00110012** — `U`, the
 * seven-digit serial `0011001`, and the Verhoeff check digit `2`. The owner asked for the first
 * eight characters exactly; the ninth is the check digit, which is retained (see below) and is the
 * only difference between the number requested and the number issued.
 *
 * WHAT THE OLD FLOOR BOUGHT AND WHY IT WAS THE WRONG TRADE. 1,234,500 existed so a first card
 * would read `U12345013` rather than `U00000017` — a hospital not advertising that it has one
 * patient. The cost is that every UHID is nine characters of which the first four are always the
 * same and carry nothing, read aloud across a counter and typed into a search box all day. The
 * owner has weighed both and chosen the short number. `11,000` is kept rather than dropping to
 * zero for the OTHER reason the band existed and which still holds: a memorable number can be
 * minted by hand out of 1..11,000 without ever colliding with the counter.
 *
 * WHY THE FLOOR IS NOT A VIP BAND — the part most likely to be "helpfully" re-added later.
 * The reserved serials carry NO MEANING. It is deliberately NOT a VIP or membership range, and
 * encoding status here would be a defect, not a feature:
 *   - A UHID is printed on the card, the prescription and the receipt, spoken across a crowded
 *     counter and sent by SMS. A semantic low band would broadcast to a ward boy or a competitor
 *     precisely the fact that `patients.is_confidential` (§14) exists to SEAL.
 *   - Status is revocable and a UHID is not. Memberships lapse, VIPs stop being VIPs, ordinary
 *     patients buy a membership next year. Status in the number forces either renumbering a
 *     living patient — the one thing a UHID exists to prevent, since it breaks every historical
 *     record and every card already printed — or a band that is a standing lie.
 *   - The revocable mechanisms already exist and are auditable: `is_confidential` for VIP,
 *     Plan 09's membership instrument for membership.
 */
export const UHID_SERIAL_DIGITS = 7;
export const UHID_RESERVED_THROUGH = 11_000;
export const UHID_MAX_SERIAL = 9_999_999; // 9,988,999 issuable serials above the floor

const UHID_RE = /^([A-Z]{1,5})(\d{7})(\d)$/;

export function isValidUhid(uhid: string): boolean {
  const m = UHID_RE.exec(uhid);
  if (!m) return false;
  return verhoeffValidates(m[2]! + m[3]!);
}

/**
 * The one place that can mint a UHID string, and therefore the one place that guards the width.
 * Out of range throws rather than truncating or over-padding: a serial of 10,000,000 would
 * silently produce an EIGHT-digit body and a UHID that `isValidUhid` rejects forever after.
 */
export function formatUhid(prefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > UHID_MAX_SERIAL) {
    throw new Error(
      `formatUhid: serial ${String(n)} is outside 1..${UHID_MAX_SERIAL} — the ${UHID_SERIAL_DIGITS}-digit body has no room for it`,
    );
  }
  const body = String(n).padStart(UHID_SERIAL_DIGITS, "0");
  return `${prefix}${body}${verhoeffCheckDigit(body)}`;
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
  // THE FLOOR IS ENFORCED HERE, not merely configured on the sequence. `startWith` is a property
  // of the sequence object, and a restore, a `RESTART`, or a hand-rolled dev reset can put the
  // counter back below it — at which point registration would quietly start issuing out of the
  // reserved band. Failing at the counter is the correct outcome: the band is a promise the
  // hospital made about numbers it will never auto-issue, and a promise nothing checks is not one.
  if (n <= UHID_RESERVED_THROUGH) {
    throw new Error(
      `uhid_seq handed out ${n}, inside the reserved band 1..${UHID_RESERVED_THROUGH}. ` +
        `Registration is halted rather than issuing a reserved UHID. Fix the counter with: ` +
        `ALTER SEQUENCE uhid_seq RESTART WITH ${UHID_RESERVED_THROUGH + 1};`,
    );
  }
  return formatUhid(cfg[0]!.uhidPrefix, n);
}
