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
