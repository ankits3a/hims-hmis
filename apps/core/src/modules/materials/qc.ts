import {
  BATCH_MANDATORY_CLASSES, MRP_MANDATORY_CLASSES, NEAR_EXPIRY_MIN_FRACTION, NEAR_EXPIRY_MIN_MONTHS,
} from "./config";
import { mrpPerBaseUnit } from "./uom";
import type { UomRow } from "./uom";

/**
 * PLAN 14 T6 / DD8 — **THE GRN GATE'S RULES, PURE, IN THE ORDER THEY RUN.**
 *
 * ═══ THE ORDER IS THE SEMANTICS, WHICH IS WHY THIS IS ONE FUNCTION AND NOT NINE ═══
 *
 * A line that names an item the hospital does not stock cannot meaningfully be checked for a
 * near-expiry bound; a line with no batch number cannot be checked against a recall; a price
 * comparison over a UoM the item does not have is arithmetic on a guess. So the rules run in a
 * fixed order and the FIRST failure is the verdict — the rule code that comes back is the one a
 * storekeeper must fix first, not the last one that happened to be evaluated.
 *
 * ═══ THE NINE, IN ORDER (DD8) ═══
 *
 *   1. the item exists and is ACTIVE
 *   2. the UoM is one of THAT ITEM's
 *   3. batch number and expiry are present when the class demands them (`BATCH_MANDATORY_CLASSES`)
 *   4. the expiry is AFTER the challan date
 *   5. residual shelf life ≥ **min(6 months, 75% of the item's own `shelf_life_days`)** — O-2, and
 *      failing it is `near_expiry`, not a rejection: it needs an approval (DD10)
 *   6. MRP present for `drug | implant`, and **MRP < landed cost is a HARD BLOCK**
 *   7. MRP > ceiling is a HARD BLOCK where a regulation is effective on the challan date
 *   8. the batch is not recall-frozen
 *   9. a consignment challan needs a valid `consignment_agreement` — **O-8**
 *
 * ═══ PURE, AND THE CONTEXT IS PASSED IN ═══
 *
 * `qcLine` touches no database. Everything it needs — the item, its UoMs, the effective regulation,
 * the batch's recall status, the vendor's agreement validity, the clock — arrives in `ctx`, which is
 * what makes A13, A15 and A16 testable as ARITHMETIC rather than as fixtures. `grn.ts` assembles the
 * context once per GRN and calls this per line.
 */

/** The rule that fired, as a code the screen renders through its locale string (T9). */
export type RuleCode =
  | "item_unknown"
  | "item_inactive"
  | "uom_unknown"
  | "batch_required"
  | "expiry_required"
  | "expired"
  | "near_expiry"
  | "mrp_required"
  | "mrp_unconvertible"
  | "mrp_below_cost"
  | "mrp_above_ceiling"
  | "batch_frozen"
  | "agreement_missing";

export type QcVerdict = { verdict: "pass" | "near_expiry" | "reject"; rule?: RuleCode };

export type QcContext = {
  /** The item, or `undefined` when the line names one that does not exist (rule 1). */
  item?: {
    id: string;
    class: string;
    active: boolean;
    /** Null when the item has no shelf life at all — rule 5 then falls back to the six-month bound. */
    shelfLifeDays: number | null;
  };
  /** THIS ITEM's units. Rule 2 and the MRP conversion both read them. */
  uoms: readonly UomRow[];
  /** The ceiling in force on the challan date, per BASE unit, or null when none is (rule 7). */
  ceilingPaisePerBase: number | null;
  /**
   * A ceiling IS in force and could NOT be expressed per base unit — CLOSE REVIEW M7.
   *
   * Distinct from `ceilingPaisePerBase: null`, which means *no ceiling was notified* and is a PASS.
   * This one means *a ceiling was notified and we cannot compare against it*, which must be a
   * REJECT. Collapsing the two — which is what a bare `null` did — makes DD8 rule 7 fail OPEN on
   * exactly the items it exists for.
   */
  ceilingUnconvertible: boolean;
  /** Whether the batch named already exists and is recall-frozen (rule 8). */
  batchFrozen: boolean;
  /** Whether a valid `consignment_agreement` is on file for the challan date (rule 9, O-8). */
  hasConsignmentAgreement: boolean;
  /** `challan` | `consignment_challan` | `donation`. */
  source: string;
  /** The challan's IST calendar date, `YYYY-MM-DD`. Rules 4 and 5 measure from here. */
  challanDate: string;
};

export type QcLine = {
  itemId: string;
  uom: string;
  qtyBase: number;
  batchNo?: string | null;
  expiryDate?: string | null;
  mrpPaise?: number | null;
  mrpUom?: string | null;
  /** PER BASE UNIT. Zero for free goods, which is why rule 6 reads `<` and not `<=`. */
  unitCostPaise: number;
  freeGoods?: boolean;
};

/** Whole days from `from` to `to`, both IST calendar dates. Negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * **O-2's BOUND, and the `min` is the whole of the rule (A13).**
 *
 * `min(6 months, 75% of the item's own shelf life)` in DAYS. Six months is taken as **183 days**
 * here — half of 366, the conservative reading — and that number lives here rather than in
 * `config.ts` because `NEAR_EXPIRY_MIN_MONTHS = 6` is the RULING and 183 is an implementation of it.
 *
 * Why `min` and not a flat six months: a three-year antibiotic with six months left has used 84% of
 * its life and should be questioned; a 180-day reagent can never HAVE six months left, and a flat
 * rule would reject every single delivery of it. **A13's discriminating input is exactly that
 * shape** — an item with `shelf_life_days = 180` and a batch expiring in 150 days. 75% of 180 is
 * 135, the lower bound wins, and 150 ≥ 135 PASSES. A six-month-only mutant marks it `near_expiry`.
 * **An item with a three-year shelf life does not discriminate**: both bounds land on 183.
 *
 * A null `shelf_life_days` falls back to the six-month bound, because "we do not know how long this
 * lives" is not a reason to accept anything.
 */
export function nearExpiryMinDays(shelfLifeDays: number | null): number {
  const sixMonths = Math.round(NEAR_EXPIRY_MIN_MONTHS * 30.5);
  if (shelfLifeDays === null || !Number.isFinite(shelfLifeDays) || shelfLifeDays <= 0) return sixMonths;
  return Math.min(sixMonths, Math.floor(shelfLifeDays * NEAR_EXPIRY_MIN_FRACTION));
}

/**
 * One line through DD8's nine rules, in order. The first failure is the verdict.
 *
 * `near_expiry` is a THIRD outcome and not a rejection: the line may still be posted, but only with
 * a granted `materials_near_expiry_acceptance` on the GRN (DD10, A17). Everything else that fails
 * is `reject`.
 */
export function qcLine(ctx: QcContext, line: QcLine): QcVerdict {
  // ── 1. the item exists and is active ──
  const item = ctx.item;
  if (item === undefined) return { verdict: "reject", rule: "item_unknown" };
  if (!item.active) return { verdict: "reject", rule: "item_inactive" };

  // ── 2. the UoM is one of THIS item's ──
  const wanted = line.uom.trim().toLowerCase();
  if (!ctx.uoms.some((u) => u.uom.trim().toLowerCase() === wanted)) {
    return { verdict: "reject", rule: "uom_unknown" };
  }

  // ── 3. batch and expiry, when the class demands them ──
  const batchMandatory = (BATCH_MANDATORY_CLASSES as readonly string[]).includes(item.class);
  const batchNo = (line.batchNo ?? "").trim();
  if (batchMandatory && batchNo === "") return { verdict: "reject", rule: "batch_required" };
  if (batchMandatory && (line.expiryDate ?? null) === null) {
    return { verdict: "reject", rule: "expiry_required" };
  }

  // ── 4. the expiry is AFTER the challan date ──
  // Evaluated only when there IS one: a class exempt from rule 3 may legitimately have none, and
  // "no expiry" is not "expired".
  const expiry = line.expiryDate ?? null;
  if (expiry !== null) {
    const residual = daysBetween(ctx.challanDate, expiry);
    // `<= 0`: stock expiring ON the day it is received is expired for every purpose that matters.
    if (residual <= 0) return { verdict: "reject", rule: "expired" };

    // ── 5. O-2's residual shelf-life bound ──
    if (residual < nearExpiryMinDays(item.shelfLifeDays)) {
      return { verdict: "near_expiry", rule: "near_expiry" };
    }
  }

  // ── 6. MRP present where the class demands it, and MRP is NOT below cost ──
  const mrpMandatory = (MRP_MANDATORY_CLASSES as readonly string[]).includes(item.class);
  const mrp = line.mrpPaise ?? null;
  if (mrpMandatory && mrp === null) return { verdict: "reject", rule: "mrp_required" };

  if (mrp !== null) {
    /**
     * Both operands in ONE unit before they are compared — DD7, and §2.93's "verify a formula where
     * its operands differ".
     *
     * **`mrpPerBaseUnit` THROWS rather than rounds, and the throw is CAUGHT here and turned into a
     * line verdict** (finding F9). It refuses an MRP that does not divide into whole paise per base
     * unit — ₹85 on a strip of 12 has no honest integer answer — and that is right. But a rule
     * engine that THREW would abort the whole `runGateQc` transaction over one mistyped price,
     * so a storekeeper with twelve good lines and one bad one would see a 409 for the delivery
     * rather than a rejection for the line. **A per-line rule must produce a per-line verdict.**
     *
     * The plan's nine rules do not name this case; the union of `RuleCode` is this file's own, so
     * the code is added here and disclosed rather than smuggled.
     */
    let mrpBase: number | null;
    try {
      mrpBase = mrpPerBaseUnit(ctx.uoms, mrp, line.mrpUom);
    } catch {
      return { verdict: "reject", rule: "mrp_unconvertible" };
    }
    if (mrpBase !== null) {
      /**
       * **`<`, NOT `<=` (A15).** An MRP EQUAL to landed cost passes: a zero-margin line is a
       * commercial decision, not a data error, and refusing it would block every at-cost transfer
       * a group hospital does. And **free goods (cost 0) never trigger it**, because nothing is
       * less than zero — which is the same fact expressed twice and is why the plan uses the
       * mrp = cost fixture as A15's discriminating leg ON PURPOSE.
       */
      if (mrpBase < line.unitCostPaise) return { verdict: "reject", rule: "mrp_below_cost" };

      // ── 7. MRP above a notified ceiling, where one is in force ──
      /**
       * ═══ CLOSE REVIEW M7 — FAIL CLOSED, AND PER LINE ═══
       *
       * `qcContextFor` used to call `mrpPerBaseUnit` on the CEILING outside any `try`, so an
       * unconvertible ceiling threw out of the context assembler, escaped `runGateQc`, and
       * `materialsHttpStatus` answered **404 for a whole delivery** — a storekeeper with twenty
       * good lines told the GRN does not exist.
       *
       * That is finding F9's lesson one level up: **a per-line rule must produce a per-line
       * verdict.** F9 fixed it for the LINE's own MRP, immediately above; the context assembler
       * that computes the other operand did not get the same treatment, and a fix that stops at
       * the first of two identical call sites is how a defect survives its own remediation.
       *
       * The direction is not arbitrary. A ceiling that cannot be compared against must REJECT,
       * never pass: the item is one the government has capped, and DD8 calls rule 7 "the cheapest
       * place to stop selling above a notified ceiling". Letting it through because the arithmetic
       * was untidy is the same fail-open M4 fixed at the other end of the same rule.
       */
      if (ctx.ceilingUnconvertible) return { verdict: "reject", rule: "mrp_unconvertible" };
      if (ctx.ceilingPaisePerBase !== null && mrpBase > ctx.ceilingPaisePerBase) {
        return { verdict: "reject", rule: "mrp_above_ceiling" };
      }
    }
  }

  // ── 8. a recall-frozen batch refuses NEW receipts ──
  if (ctx.batchFrozen) return { verdict: "reject", rule: "batch_frozen" };

  // ── 9. O-8 — no signed agreement on file, no consignment GRN ──
  if (ctx.source === "consignment_challan" && !ctx.hasConsignmentAgreement) {
    return { verdict: "reject", rule: "agreement_missing" };
  }

  return { verdict: "pass" };
}
