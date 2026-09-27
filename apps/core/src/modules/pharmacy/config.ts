import { IST_UTC_OFFSET_MINUTES } from "../../kernel/approvals/cumulative";

/**
 * PLAN 16c — the dispense counter's constants. Values, not logic: a later phase or an owner ruling
 * moves a number here without touching a transition (the `materials/config.ts` posture).
 */

/** The materials store the OPD counter picks from (D2). Created by the go-live runbook via `createStore`. */
export const OPD_PHARMACY_STORE_CODE = "PHARM-OPD";

/**
 * PHARMACY P19 (R-174) — the walk-in retail counter's own store. Created by `seed:pharmacy` beside
 * the OPD counter's, stocked by transfer, and never the OPD counter's shelf.
 */
export const RETAIL_PHARMACY_STORE_CODE = "PHARM-RETAIL";

/** P19 — the ledger's `ref_type` for a walk-in sale's `consume` row: `ref_id` is the sale LINE. */
export const RETAIL_REF_TYPE = "pharmacy_retail_sale";

/**
 * PHARMACY P20 — how long after an outage a paper dispense may still be entered. A week covers a
 * long outage and the weekend after it; an older sheet is an incident, not a backlog.
 */
export const DOWNTIME_BACKFILL_DAYS = 7;

/** D2 — how long a pick holds a batch before the ledger may release it to somebody else. */
export const PICK_RESERVATION_MINUTES = 30;

/** D6 / doc 16 O-4 (owner adopted the default 2026-09-02): generic substitution ON, with consent captured. */
export const PHARMACY_SUBSTITUTION_ENABLED = true;

/** D7 — the schedules whose hand-over needs `pharmacy.dispense.scheduled` (a registered pharmacist). */
export const SCHEDULED_FLAGS = ["H", "H1"] as const;

/**
 * R-3 (owner ruling 2026-09-02) — refused at the OPD counter until 16d's double custody. PHARMACY P6 (owner
 * ruling 2026-09-26): still refused WITHOUT a current Form 20F licence, and at the walk-in and paper
 * counters always; with the licence the line is a controlled one (`controlled.ts`), picked from the cabinet
 * and handed over under two keys.
 */
export const REFUSED_FLAGS = ["X"] as const;

/**
 * PHARMACY P6 — the controlled-drug cabinet: a materials store whose attributes say `controlled: true`,
 * where every narcotic, psychotropic and Schedule X drug is kept (D&C Rules r.65(12): "under lock and key
 * in a cupboard or drawer reserved solely for" them) and every movement is made by two people. Seeded by
 * `seed:pharmacy`.
 */
export const CONTROLLED_STORE_CODE = "PHARM-NDPS";

/**
 * PHARMACY P6 — a controlled-drug licence inside its last this-many days is due for renewal: RMI
 * recognition is applied for "at least sixty days before the expiry" (NDPS Rules r.52-O); the same notice
 * serves the Form 20F retention fee.
 */
export const LICENCE_RENEWAL_NOTICE_DAYS = 60;

/** R-4 — the schedule whose hand-over writes a register row (Rule 65(3)). */
export const REGISTER_FLAGS = ["H1"] as const;

/**
 * The IST calendar date of an instant, `YYYY-MM-DD` — what `serviceDate` means everywhere in OPD.
 * Derived from the kernel's one exported offset (`ist-clock-parity.test.ts` pins every literal copy).
 */
/**
 * PHARMACY P15 — a state council registration inside its last this-many days is due for renewal. The
 * day after it lapses, verify refuses the pharmacist at the counter (`pharmacist_not_registered`),
 * so the register screen and the go-live census say so two months ahead.
 */
export const REGISTRATION_RENEWAL_NOTICE_DAYS = 60;

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
/** P19b — the same for a pack back from a walk-in sale or a paper dispense: `ref_id` is the SALE line. */
export const RETAIL_RETURN_REF_TYPE = "pharmacy_retail_return";

/**
 * PARITY P2 — the expected-delivery date the agent's DRAFT orders carry: this many days from today.
 * A distributor in the same city delivers next day or the day after; three leaves a margin. The
 * person reviewing the draft changes it; the office's "overdue" card reads it. DECIDED (not money,
 * not procurement authority — a default a pharmacist edits on every order).
 */
export const PURCHASE_DEFAULT_LEAD_DAYS = 3;

/**
 * PHARMACY P6 (patient messages) — the pharmacy's two templates in the notify kernel's registry
 * (`kernel/notify/templates.ts`): the bill after a sale, the opt-in refill reminder.
 */
export const PHARMACY_BILL_TEMPLATE = "pharmacy_bill_ready";
export const PHARMACY_REFILL_TEMPLATE = "pharmacy_refill_due";
export const PHARMACY_MESSAGE_TEMPLATES = [PHARMACY_BILL_TEMPLATE, PHARMACY_REFILL_TEMPLATE] as const;

/**
 * PHARMACY P6 — the refill reminder's three numbers. DECIDED as common Indian retail-pharmacy practice
 * (no owner ruling needed: not money, procurement or law):
 *   - remind 3 days before the medicines run out — time to come in, not so early it is forgotten;
 *   - only a line lasting 20 days or more is "chronic-looking": a 5-day antibiotic is finished, not refilled;
 *   - look back 200 days, which holds a six-month course with a margin.
 */
export const REFILL_REMINDER_LEAD_DAYS = 3;
export const REFILL_MIN_SUPPLY_DAYS = 20;
export const REFILL_LOOKBACK_DAYS = 200;

/**
 * PHARMACY P6 — MAY A REMINDER NAME THE MEDICINES? OFF. The owner may switch it on; until then a message
 * names no drug at all, because a name on a shared phone is a diagnosis. Even ON, a Schedule X, NDPS or
 * H1 line is never named (`messages.ts` `namableDrugs`) — and turning it on means registering the
 * named wording with DLT and WhatsApp first, or the gateways will drop every such message.
 */
export const REFILL_REMINDER_NAMES_DRUGS = false;
