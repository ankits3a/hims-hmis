/**
 * PLAN 14 T2 — the materials module's CONFIGURATION CONSTANTS.
 *
 * ═══ WHY THESE ARE NAMED EXPORTS AND NOT LITERALS IN LOGIC (§ 4A, and ledger §2.54) ═══
 *
 * Four of the values below are OWNER RULINGS taken on 2026-08-27 (O-2, O-6, O-8, O-11), and the
 * §4A paragraph that records them says in as many words: *"Values are configuration constants in
 * `materials/config.ts` with those defaults, not literals in logic — the CA/counsel sessions
 * (R-097, R-102) may move them without a code change."* A number typed into a rule is a number
 * that has to be found by grep when counsel changes it, and found in every place it was typed.
 *
 * ═══ ONE CONSTANT, ONE OWNER — EACH EXPORT IS READ BY EXACTLY ONE LOGIC FILE ═══
 *
 * That is 16a's DD5 and §2.54's remedy applied at declaration time rather than after the drift.
 * The owner of each is named beside it. If a second file needs one of these, the right move is for
 * the FIRST file to expose a function, not for the second to read the constant — otherwise the two
 * callers will eventually disagree about the units.
 */

/**
 * **O-2 RULED 2026-08-27** — the near-expiry bound, DD8 rule 5, read by `qc.ts` and by nothing else.
 *
 * The rule is `min(NEAR_EXPIRY_MIN_MONTHS, NEAR_EXPIRY_MIN_FRACTION × shelf_life_days)`, and the
 * `min` is the whole of it: a three-year antibiotic and a 180-day reagent cannot share one bound.
 * Six months of residual life on a 3-year drug is 16% of its life and rightly refused; six months
 * on a 180-day reagent is longer than the reagent has ever lived, and a flat six-month rule would
 * reject every single delivery of it (A13). The fast-mover exception the brainstorm asked about IS
 * the approval — `materials_near_expiry_acceptance` — rather than a second constant.
 *
 * `NEAR_EXPIRY_MIN_MONTHS` is expressed in DAYS at the point of use, and 6 months is taken as 183
 * days there rather than here, because "six months" is the RULING and 183 is an implementation of
 * it that `qc.ts` documents.
 */
export const NEAR_EXPIRY_MIN_MONTHS = 6;
/** The other half of O-2. 0.75 of the item's own `shelf_life_days`. Read by `qc.ts`. */
export const NEAR_EXPIRY_MIN_FRACTION = 0.75;

/**
 * **O-6 RULED 2026-08-27** — a vendor whose bank account has just changed cannot be paid for seven
 * days. Read by `vendors.ts` (`applyBankChange`), which stamps both `vendor_bank_changes.cooling_off_until`
 * and `vendors.first_payment_allowed_at` from the GRANT instant.
 *
 * **Nothing in this phase pays anyone, so nothing here can ENFORCE it** (DD10). 14c's payment run
 * refuses a payee whose `first_payment_allowed_at` is in the future. The column exists now so that
 * 14c READS the date rather than re-deriving it from the change row — two derivations of one date
 * is §2.54 pointed at money.
 */
export const BANK_CHANGE_COOLING_OFF_DAYS = 7;

/**
 * **O-11 RULED 2026-08-27** — blacklist for three years, and `reinstateVendor` before
 * `blacklist_until` is REFUSED (`blacklist_active`, A5). Read by `vendors.ts`.
 */
export const BLACKLIST_YEARS = 3;

/**
 * **O-11's four trigger codes**, and `blacklistVendor` takes its reason FROM THIS LIST rather than
 * as free text. Read by `vendors.ts`.
 *
 * Free text was the alternative and it is the wrong one: a blacklist is a three-year commercial
 * sanction with a legal tail, 14b's vendor scorecard needs to count them by kind, and "poor
 * quality" written forty different ways counts as forty different things. A reason outside this
 * list is a NEW SANCTION CLASS and belongs to whoever rules on it, not to the storekeeper typing
 * the row.
 */
export const BLACKLIST_REASONS = [
  /** Supplied goods that failed QC materially or repeatedly — the doc 09 §3 trigger. */
  "quality_failure",
  /** Spurious, falsified, or licence-less stock. The one with a criminal tail. */
  "regulatory_breach",
  /** An inducement offered to a buyer, a prescriber, or a storekeeper. */
  "integrity_breach",
  /** Persistent non-supply against accepted orders — the commercial trigger. */
  "chronic_non_supply",
] as const;

export type BlacklistReason = (typeof BLACKLIST_REASONS)[number];

/**
 * DD14 — the day-thresholds `sweepBatchExpiry` announces at, ONCE PER BATCH PER THRESHOLD.
 * Read by `expiry.ts` (T8) and by nothing else.
 *
 * DESCENDING is load-bearing: the sweep takes the FIRST threshold a batch has crossed and not yet
 * been notified for, so a batch that first appears with 40 days left announces 60 and 30 in that
 * order rather than announcing 90 for something already inside a month.
 */
export const EXPIRY_THRESHOLD_DAYS = [90, 60, 30] as const;

/**
 * §31(7) of the CGST Act: consignment stock not returned or paid for within 180 days of the challan
 * is a DEEMED SUPPLY on the challan date. Read by `grn.ts`, which computes
 * `deemed_supply_deadline = challan_date + DEEMED_SUPPLY_DAYS` AT INSERT and never recomputes it.
 *
 * That "never recomputes" is why this constant is safe to make configurable: moving it changes what
 * FUTURE lots get, and cannot move a deadline a tax position already depends on.
 */
export const DEEMED_SUPPLY_DAYS = 180;

/**
 * DD3 / DD8 rule 3 — the item classes for which a BATCH NUMBER AND AN EXPIRY DATE are mandatory at
 * the gate. Read by `qc.ts` and by nothing else, and stated ONCE (the plan says "that list is ONE
 * constant in `items.ts` read by the GRN gate — never restated").
 *
 * **THE PLAN NAMES TWO ADDRESSES FOR THIS ONE CONSTANT AND THEY DISAGREE — finding F3.** DD3 says
 * *"that list is ONE constant in `items.ts` read by the GRN gate"*; T2's own Produces list puts
 * `BATCH_MANDATORY_CLASSES` in THIS file, among the constants "each a named export read by exactly
 * one logic file". T2's list wins, because it is the operative instruction for the task that
 * creates the file — and because it is also the better address: `items.ts` is created by T3 and
 * `qc.ts` by T6, so a constant here is readable by both without either task editing the other's
 * file, while a constant in `items.ts` would make T6 depend on T3's module surface for a policy
 * that is not about items at all. The plan's INTENT — one constant, one owner, never restated — is
 * what both sentences agree on and what is preserved.
 *
 * NOT a database CHECK, unlike `ITEM_CLASS_VALUES`: this is a POLICY that a licensing change may
 * move, and that is a different kind of thing from the closed SET of classes, which a migration
 * must move. `materials.ts`'s header says the same in the other direction.
 */
export const BATCH_MANDATORY_CLASSES = ["drug", "consumable_dated", "reagent", "implant"] as const;

/**
 * DD8 rule 6 — the classes for which an MRP must be present on the GRN line. Read by `qc.ts`.
 *
 * A drug's MRP is a statutory printed price and an implant's is what the patient will be charged;
 * a box of gloves has a cost and no consumer price at all. Requiring MRP on everything would make
 * the storekeeper invent one, which is worse than not having it.
 */
export const MRP_MANDATORY_CLASSES = ["drug", "implant"] as const;

/*
 * `MRP_MANDATORY_CLASSES` above and `TRANSIT_STORE_CODE` below are NOT in T2's enumerated Produces
 * list. They are here because DD8 rule 6 and DD9 each name a value that would otherwise be a
 * literal in `qc.ts` and `stores.ts` — precisely the shape this file exists to prevent — and
 * because T2 is the only task whose Files list carries `config.ts`, so a later task could not add
 * them without editing a file it does not own. Recorded as finding F4 rather than added silently.
 */

/**
 * DD9 — the CODE of the per-site transit store `ensureTransitStore` creates lazily, and the code
 * `listStores` excludes. Read by `stores.ts` and by nothing else: the exclusion is ONE predicate in
 * ONE reader (Plan 13 DD9's discipline), so every other caller sees the transit store exactly as
 * the real place it is.
 */
export const TRANSIT_STORE_CODE = "IN-TRANSIT";
