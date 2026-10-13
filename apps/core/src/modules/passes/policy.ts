import { PASS_VISITING_HOURS } from "@hmis/contracts";
import type { PassIssueKind, PassKind, PassScanResult, PassState } from "@hmis/contracts";

/**
 * E1.3 (#720) — THE PASS RULES, PURE (no database): what an admission is entitled to, whether a time is inside
 * visiting hours, and the one answer a scan gives. The intents and the scan call these after reading the facts.
 */

/** Critical-care classes: no attendant at the bedside, one lounge pass for the family (SPEC-ipd-companions §8). */
export const PASS_CRITICAL_CLASSES: ReadonlySet<string> = new Set(["hdu", "icu", "nicu", "picu"]);
/** Classes with a private room: two attendants. */
const TWO_ATTENDANT_CLASSES: ReadonlySet<string> = new Set(["private", "deluxe", "suite"]);
/** Under this age on the day, the bedside pass is a parent-stay pass (the IPD bed rules' child age). */
export const PASS_CHILD_AGE_YEARS = 14;

const CLASS_WORDS: Record<string, string> = {
  general: "General ward", semi_private: "Semi-private", private: "Private room", deluxe: "Deluxe room", suite: "Suite",
  hdu: "HDU", icu: "ICU", nicu: "NICU", picu: "PICU", ldr: "Labour room", daycare: "Day care", emergency: "Emergency",
  overflow: "Extra bed",
};

export type EntitlementFacts = { bedClass: string | null; ageYears: number | null; policeCustody: boolean };
export type Entitlement = { kind: PassIssueKind; max: number; basis: string };

export function isChild(f: Pick<EntitlementFacts, "bedClass" | "ageYears">): boolean {
  return (f.ageYears !== null && f.ageYears < PASS_CHILD_AGE_YEARS) || f.bedClass === "nicu" || f.bedClass === "picu";
}

/** The bedside (or lounge, or police guard) kind and how many an admission may hold live at once. */
export function entitlementFor(f: EntitlementFacts): Entitlement {
  if (f.policeCustody) return { kind: "police_guard", max: 2, basis: "Police custody: police guard only" };
  const cls = f.bedClass ?? "general";
  const words = CLASS_WORDS[cls] ?? cls;
  if (PASS_CRITICAL_CLASSES.has(cls)) return { kind: "lounge", max: 1, basis: `${words}: lounge pass only` };
  const max = TWO_ATTENDANT_CLASSES.has(cls) ? 2 : 1;
  if (isChild(f)) return { kind: "parent_stay", max, basis: `${words}, child: ${String(max)} parent stay` };
  return { kind: "attendant", max, basis: `${words}: ${String(max)} attendant${max === 1 ? "" : "s"}` };
}

/** Kinds whose pass carries a `valid_to` (ends by the clock, not only by an act). */
export const TIMED_PASS_KINDS: readonly PassKind[] = ["visitor"];
/**
 * Kinds that count against the bedside entitlement (the visitor and the NICU mother pass do not).
 * DECIDED (review of #755): the entitlement count ignores `valid_to`, because none of these kinds is timed — every one
 * lives until an act ends it. `policy.test.ts` pins that this list and `TIMED_PASS_KINDS` never meet; a timed kind
 * added here would need the count to filter on `valid_to` (as the visitor count does).
 */
export const ENTITLEMENT_KINDS: readonly PassKind[] = ["attendant", "parent_stay", "lounge", "police_guard"];

const IST_OFFSET_MS = 330 * 60_000;
export function istMinuteOfDay(at: Date): number {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function inVisitingHours(at: Date): boolean {
  const m = istMinuteOfDay(at);
  return m >= PASS_VISITING_HOURS.startMinute && m < PASS_VISITING_HOURS.endMinute;
}

export type ScanFacts = {
  state: PassState;
  kind: PassKind;
  validTo: Date | null;
  wardId: string | null;
  /** The admission (or the linked baby's admission) has ended, read live: the consumer may not have run yet. */
  admissionEnded: boolean;
};

/**
 * One answer per scan, checked in this order: ended (revoked, expired, the stay over, past its day), then paused, then
 * the ward, then visiting hours. A guard needs the strongest "no" first: a revoked pass at the wrong ward is revoked.
 */
export function scanResult(p: ScanFacts, at: Date, wardId: string | undefined): PassScanResult {
  if (p.state === "revoked") return "revoked";
  if (p.state === "expired" || p.admissionEnded || (p.validTo !== null && at.getTime() >= p.validTo.getTime())) return "expired";
  if (p.state === "paused") return "paused";
  if (wardId !== undefined && p.wardId !== null && p.wardId !== wardId) return "wrong_ward";
  if (p.kind === "visitor" && !inVisitingHours(at)) return "outside_hours";
  return "valid";
}

export const SCAN_WORDS: Record<PassScanResult, string> = {
  valid: "Valid", wrong_ward: "Wrong ward", outside_hours: "Outside visiting hours", expired: "Expired",
  revoked: "Revoked", paused: "Paused", unknown: "Not a pass",
};
