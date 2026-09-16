import { IST_UTC_OFFSET_MINUTES } from "../../kernel/approvals/cumulative";

/**
 * PLAN 16c — the dispense counter's constants. Values, not logic: a later phase or an owner ruling
 * moves a number here without touching a transition (the `materials/config.ts` posture).
 */

/** The materials store the OPD counter picks from (D2). Created by the go-live runbook via `createStore`. */
export const OPD_PHARMACY_STORE_CODE = "PHARM-OPD";

/** D2 — how long a pick holds a batch before the ledger may release it to somebody else. */
export const PICK_RESERVATION_MINUTES = 30;

/** D6 / doc 16 O-4 (owner adopted the default 2026-09-02): generic substitution ON, with consent captured. */
export const PHARMACY_SUBSTITUTION_ENABLED = true;

/** D7 — the schedules whose hand-over needs `pharmacy.dispense.scheduled` (a registered pharmacist). */
export const SCHEDULED_FLAGS = ["H", "H1"] as const;

/** R-3 (owner ruling 2026-09-02) — refused at the OPD counter until 16d's double custody. */
export const REFUSED_FLAGS = ["X"] as const;

/** R-4 — the schedule whose hand-over writes a register row (Rule 65(3)). */
export const REGISTER_FLAGS = ["H1"] as const;

/**
 * The IST calendar date of an instant, `YYYY-MM-DD` — what `serviceDate` means everywhere in OPD.
 * Derived from the kernel's one exported offset (`ist-clock-parity.test.ts` pins every literal copy).
 */
/**
 * A real calendar date written YYYY-MM-DD. `Date.parse` alone is not the test: V8 reads
 * "2026-02-30" as 2 March. So the parsed date must print back as the same string.
 */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function istDateOf(at: Date): string {
  return new Date(at.getTime() + IST_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/**
 * PHARMACY P4 — THE REORDER LIST'S THREE NUMBERS (doc 16 §9, Replenishment, drafting tier).
 *
 * An OPD counter is a sub-store: the standard Indian hospital practice is a short cover at the
 * window, topped up from the main store, with the main store holding the month. So the counter
 * reorders when it has under THREE days of its own recent use left, and tops up to SEVEN. Use is
 * measured over the last THIRTY days, long enough to smooth a slow week and short enough to follow
 * a season. DECIDED under the owner's 2026-09-16 instruction; they are constants rather than
 * configuration until a pharmacist asks to change one.
 */
export const REORDER_WINDOW_DAYS = 30;
export const REORDER_MIN_COVER_DAYS = 3;
export const REORDER_TARGET_COVER_DAYS = 7;

/**
 * PHARMACY P6 — SALES RETURNS (doc 16 O-7, the standard Indian retail-pharmacy policy): within
 * SEVEN days of the hand-over, sealed and intact, in whole issue packs, and never a cold-chain,
 * frozen or narcotic item, whose storage after it left the counter nobody can vouch for. A batch
 * with under THIRTY days to expiry is not put back on the shelf: the counter would only have to
 * pull it again.
 */
export const RETURN_WINDOW_DAYS = 7;
export const RETURN_MIN_SHELF_DAYS = 30;
export const RETURN_REFUSED_STORAGE = ["cold_2_8", "frozen", "narcotic"] as const;
/** The ledger's `ref_type` for a counter's sales return: `ref_id` is the dispense LINE. */
export const RETURN_REF_TYPE = "pharmacy_return";
