import type { IpdBedClass, IpdChargeComponent, IpdPayerSplit, IpdSplitException, IpdSplitLine, IpdSplitReason } from "@hmis/contracts";

/**
 * E2.2 (#726) — THE PAYER SPLIT ENGINE (spec SPEC-ipd-core §2 answer 5, §4.3; decision 0072 answer 5). PURE: lines,
 * the authorisation's state and terms, and the non-payables list in; per line payer paise, patient paise and reason
 * codes out. Nothing here reads a clock, a table or a price — every cap and amount is what the TPA desk typed.
 *
 * ORDER, per line (IRDAI practice, DECIDED):
 *   1. a reversed line and its reversal are both 0/0 (`reversed`) — the pair nets to nothing;
 *   2. the mode decides first: cash / reimbursement → all patient (`cash`, or `denied` after a denial); scheme → all
 *      payer (`scheme`) less the approved non-covered amounts (step 7); insured with the pre-auth denied → all patient
 *      (`denied`), still pending → all patient (`auth_pending`) until the insurer approves, and an approval covers the
 *      stay FROM ADMISSION (day-1 lines too);
 *   3. non-payables (service code or tariff category on the list; a canteen line always) → all patient (`non_payable`);
 *   4. the room-rent cap (review $8): on a day whose room line's TAXABLE value (ex-GST) exceeds the cap and whose
 *      class is not critical care, the room line and that day's nursing, RMO and visits are paid in the ratio
 *      cap / taxable rent — applied to the taxable value, the line's GST following its taxable split, i.e. net ×
 *      cap / taxable rent (`room_rent_over_cap` on the room line, `room_rent_cap_proportional` on the others).
 *      Pharmacy, consumables, implants and diagnostics are never proportionally deducted (IRDAI 2020);
 *   5. co-pay on what the payer still carries (`co_pay`) — after the cap;
 *   6. the approved amount, consumed in POSTING ORDER (postedAt, then id — review $2): a line posted later never takes
 *      approval from one posted earlier, so a printed bill's earlier lines never flip on a later read;
 *   7. scheme only (review $7): the granted non-covered amounts are carved out of the LATEST lines in posting order —
 *      payer reduced, patient increased (`non_covered`); never more than the lines carry.
 * ROUNDING (review $3, DECIDED): steps 4–5 are exact fractions; the payer share of each (service date, component) group
 * is rounded DOWN once, then distributed to the group's lines by each line's floor plus one paisa to the largest
 * remainders (ties by line id). Payer + patient always equals each line exactly.
 */

/** Room classes exempt from the cap and the proportional deduction (DECIDED $: critical care, HDU included). */
export const CAP_EXEMPT_CLASSES: ReadonlySet<IpdBedClass> = new Set(["icu", "nicu", "picu", "hdu"]);
/** The components that scale with the room category and so take the proportional deduction (DECIDED, E2.2). */
export const PROPORTIONAL_COMPONENTS: ReadonlySet<IpdChargeComponent> = new Set(["nursing", "rmo", "visit", "cross_visit"]);

export type SplitLineInput = {
  id: string;
  serviceDate: string;
  /** #785: `lab` / `imaging` lines take no proportional deduction (diagnostics, never room-scaled). */
  component: IpdChargeComponent;
  billedClass: IpdBedClass | null;
  serviceCode: string;
  /** The tariff service's category (for the non-payables list); null when unknown. */
  category: string | null;
  /** Gross less discount, before GST (the room-rent cap compares this). */
  taxablePaise: number;
  netPaise: number;
  source: string;
  reversalOf: string | null;
  postedAt: string;
};

export type SplitMode = IpdPayerSplit["mode"];
export type AuthState = IpdPayerSplit["authState"];

export type SplitTerms = {
  mode: SplitMode;
  authState: AuthState;
  preAuthNumber: string | null;
  /** The approved total; 0 when nothing is approved. */
  approvedTotalPaise: number;
  /** Eligible rent per day, resolved (absolute, or % of sum insured); null = no cap. */
  roomRentCapPaise: number | null;
  coPayBp: number | null;
  /** A denial is on the record with no approval after it (cash from admission, even after the payer moved to cash). */
  deniedEver: boolean;
  exceptions: IpdSplitException[];
  schemeNonCoveredPaise: number;
};

export type NonPayables = { services: ReadonlySet<string>; categories: ReadonlySet<string> };
export const NO_NON_PAYABLES: NonPayables = { services: new Set(), categories: new Set() };

/** Posting order: postedAt, then id (review $2). */
const POSTING_ORDER = (a: SplitLineInput, b: SplitLineInput): number =>
  a.postedAt < b.postedAt ? -1 : a.postedAt > b.postedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** ₹ with Indian grouping; paise shown only when present. */
export function rupeeText(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Basis points as a percentage, two decimals at most ("50 %", "33.33 %"). */
export function pctText(bp: number): string {
  return `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} %`;
}

/**
 * Review $3 — one group's payer shares: each line's exact share is `net × num / den` (BigInt, no overflow); the group
 * total is floored once and handed out as each line's floor plus one paisa to the largest remainders, ties by line id.
 */
export function distributeGroup(lines: readonly { id: string; net: number }[], num: bigint, den: bigint): Map<string, number> {
  const parts = lines.map((l) => {
    const exact = BigInt(l.net) * num;
    return { id: l.id, floor: exact / den, rem: exact % den };
  });
  const total = parts.reduce((t, p) => t + p.floor * den + p.rem, 0n) / den;
  let left = Number(total - parts.reduce((t, p) => t + p.floor, 0n));
  const out = new Map(parts.map((p) => [p.id, Number(p.floor)] as const));
  const byRem = [...parts].sort((x, y) => (x.rem > y.rem ? -1 : x.rem < y.rem ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const p of byRem) {
    if (left <= 0) break;
    out.set(p.id, out.get(p.id)! + 1);
    left -= 1;
  }
  return out;
}

export function splitBill(lines: readonly SplitLineInput[], terms: SplitTerms, nonPayables: NonPayables = NO_NON_PAYABLES): IpdPayerSplit {
  const sorted = [...lines].sort(POSTING_ORDER);
  const reversedIds = new Set(sorted.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  const dead = (l: SplitLineInput): boolean => l.reversalOf !== null || reversedIds.has(l.id);

  // The taxable rent of each day: its ONE live nightly room line (the day rule guarantees one — review 10).
  const rentOf = new Map<string, { rent: number; cls: IpdBedClass | null }>();
  for (const l of sorted) {
    if (l.component !== "room" || l.source !== "ipd.nightly" || dead(l)) continue;
    if (rentOf.has(l.serviceDate)) throw new Error(`payer split: two live nightly room lines on ${l.serviceDate} (the day rule allows one)`);
    rentOf.set(l.serviceDate, { rent: l.taxablePaise, cls: l.billedClass });
  }
  const cap = terms.roomRentCapPaise;
  const cappedDay = (date: string): { rent: number; cap: number } | null => {
    const d = rentOf.get(date);
    if (cap === null || d === undefined || d.rent <= cap) return null;
    if (d.cls !== null && CAP_EXEMPT_CLASSES.has(d.cls)) return null;
    return { rent: d.rent, cap };
  };

  const totals = { payerPaise: 0, patientPaise: 0, nonPayablePaise: 0, capDeductionPaise: 0, coPayPaise: 0, overApprovedPaise: 0 };
  const result = new Map<string, IpdSplitLine>();
  const cappedDays = new Map<string, { rent: number; cap: number }>();
  const whole = (l: SplitLineInput, reason: IpdSplitReason, toPayer: boolean): IpdSplitLine =>
    ({ lineId: l.id, payerPaise: toPayer ? l.netPaise : 0, patientPaise: toPayer ? 0 : l.netPaise, reasons: [reason] });
  const nonPayable = (l: SplitLineInput): boolean =>
    nonPayables.services.has(l.serviceCode.toLowerCase()) || (l.category !== null && nonPayables.categories.has(l.category.toLowerCase()));

  // Pass 1: whole-line decisions; the rest are grouped by (service date, component) for the exact shares.
  const groups = new Map<string, SplitLineInput[]>();
  for (const l of sorted) {
    if (dead(l)) result.set(l.id, { lineId: l.id, payerPaise: 0, patientPaise: 0, reasons: ["reversed"] });
    // CN-1 (#977, decision 0088): a canteen meal is never a scheme's or an insurer's — whatever their lists say.
    else if (l.component === "canteen" && (terms.mode === "scheme" || terms.mode === "insured")) {
      result.set(l.id, whole(l, "non_payable", false));
      totals.nonPayablePaise += l.netPaise;
    } else if (terms.mode === "scheme") result.set(l.id, whole(l, "scheme", true));
    else if (terms.mode !== "insured") result.set(l.id, whole(l, terms.deniedEver ? "denied" : "cash", false));
    else if (terms.authState === "denied") result.set(l.id, whole(l, "denied", false));
    else if (terms.authState !== "approved") result.set(l.id, whole(l, "auth_pending", false));
    else if (nonPayable(l)) {
      result.set(l.id, whole(l, "non_payable", false));
      totals.nonPayablePaise += l.netPaise;
    } else {
      const k = `${l.serviceDate}|${l.component}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
  }

  // Pass 2: cap and co-pay as exact fractions, rounded once per group.
  const bp = BigInt(terms.coPayBp ?? 0);
  for (const group of groups.values()) {
    const first = group[0]!;
    const day = cappedDay(first.serviceDate);
    const capped = day !== null && (first.component === "room" || PROPORTIONAL_COMPONENTS.has(first.component));
    if (capped) cappedDays.set(first.serviceDate, day);
    const capNum = capped ? BigInt(day.cap) : 1n;
    const capDen = capped ? BigInt(day.rent) : 1n;
    const afterCap = distributeGroup(group.map((l) => ({ id: l.id, net: l.netPaise })), capNum, capDen);
    const afterCoPay = distributeGroup(group.map((l) => ({ id: l.id, net: l.netPaise })), capNum * (10_000n - bp), capDen * 10_000n);
    for (const l of group) {
      const reasons: IpdSplitReason[] = [];
      if (capped) reasons.push(first.component === "room" ? "room_rent_over_cap" : "room_rent_cap_proportional");
      const capPaid = afterCap.get(l.id)!;
      const paid = afterCoPay.get(l.id)!;
      totals.capDeductionPaise += l.netPaise - capPaid;
      if (bp > 0n && capPaid > 0) { reasons.push("co_pay"); totals.coPayPaise += capPaid - paid; }
      result.set(l.id, { lineId: l.id, payerPaise: paid, patientPaise: l.netPaise - paid, reasons });
    }
  }

  // Pass 3: the approved amount, in posting order.
  if (terms.mode === "insured" && terms.authState === "approved") {
    let carried = 0;
    for (const l of sorted) {
      const r = result.get(l.id)!;
      if (r.payerPaise <= 0 || r.reasons.includes("reversed")) continue;
      const room = Math.max(terms.approvedTotalPaise - carried, 0);
      if (r.payerPaise > room) {
        totals.overApprovedPaise += r.payerPaise - room;
        r.patientPaise += r.payerPaise - room;
        r.payerPaise = room;
        r.reasons.push("over_approved_amount");
      }
      carried += r.payerPaise;
    }
  }

  // Pass 4 (scheme): carve the approved non-covered amounts out of the latest lines.
  if (terms.mode === "scheme" && terms.schemeNonCoveredPaise > 0) {
    let left = terms.schemeNonCoveredPaise;
    for (const l of [...sorted].reverse()) {
      if (left <= 0) break;
      const r = result.get(l.id)!;
      if (r.payerPaise <= 0) continue;
      const take = Math.min(left, r.payerPaise);
      r.payerPaise -= take;
      r.patientPaise += take;
      r.reasons.push("non_covered");
      left -= take;
    }
  }

  const out = sorted.map((l) => result.get(l.id)!);
  for (const r of out) { totals.payerPaise += r.payerPaise; totals.patientPaise += r.patientPaise; }

  return {
    mode: terms.mode, authState: terms.authState, preAuthNumber: terms.preAuthNumber,
    approvedTotalPaise: terms.authState === "approved" ? terms.approvedTotalPaise : null,
    roomRentCapPaise: cap, coPayBp: terms.coPayBp,
    lines: out, totals, schemeNonCoveredPaise: terms.mode === "scheme" ? terms.schemeNonCoveredPaise : 0,
    words: splitWords(terms, totals, cappedDays),
    exceptions: terms.exceptions,
  };
}

function splitWords(
  terms: SplitTerms, totals: IpdPayerSplit["totals"], cappedDays: ReadonlyMap<string, { rent: number; cap: number }>,
): string[] {
  const words: string[] = [];
  if (terms.mode === "scheme") {
    words.push(terms.schemeNonCoveredPaise > 0 ? `Scheme pays all; approved non-covered ${rupeeText(terms.schemeNonCoveredPaise)}` : "Scheme pays all; patient pays nothing");
    return words;
  }
  if (terms.mode === "cash") words.push(terms.deniedEver ? "Pre-auth denied: cash from admission" : "Cash: patient pays all");
  if (terms.mode === "reimbursement") words.push("Reimbursement: patient pays, claims later");
  if (terms.mode !== "insured") return words;
  if (terms.authState === "denied") words.push("Pre-auth denied: cash from admission");
  if (terms.authState === "pending" || terms.authState === "none") words.push("Awaiting authorisation: patient-payable until approved");
  // One line per distinct rent over the cap, in date order ("Room ₹4,000/day over ₹2,000 cap: nursing, RMO, visits paid 50 %").
  const seen = new Set<string>();
  for (const [, d] of [...cappedDays.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const k = `${String(d.rent)}/${String(d.cap)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    words.push(`Room ${rupeeText(d.rent)}/day over ${rupeeText(d.cap)} cap: nursing, RMO, visits paid ${pctText(Math.floor((d.cap * 10_000) / d.rent))}`);
  }
  if (totals.capDeductionPaise > 0) words.push(`Room-rent cap deduction ${rupeeText(totals.capDeductionPaise)}`);
  if (totals.nonPayablePaise > 0) words.push(`Non-payables ${rupeeText(totals.nonPayablePaise)}`);
  if (totals.coPayPaise > 0) words.push(`Co-pay ${pctText(terms.coPayBp ?? 0)}: ${rupeeText(totals.coPayPaise)}`);
  if (totals.overApprovedPaise > 0) words.push(`Above approved ${rupeeText(terms.approvedTotalPaise)}: ${rupeeText(totals.overApprovedPaise)}`);
  return words;
}

// ═══════════════════════════════════════ the authorisation record → terms ═══════════════════════════════════════

export type AuthRowInput = {
  id: string;
  entry: string;
  status: string;
  preAuthNumber: string | null;
  approvedTotalPaise: number;
  counsellingDocumentId: string | null;
  roomRentCapPaise: number | null;
  roomRentCapSiBp: number | null;
  coPayBp: number | null;
  recordedAt: Date;
};

const APPROVED = new Set(["approved", "partially_approved", "final_approved"]);
const isDenial = (r: AuthRowInput): boolean => r.entry === "denial" || r.status === "denied";

export function splitModeOf(payerKind: string | null): SplitMode {
  if (payerKind === "pmjay" || payerKind === "state_scheme") return "scheme";
  if (payerKind === "insurance_cashless" || payerKind === "corporate") return "insured";
  if (payerKind === "insurance_reimbursement") return "reimbursement";
  return "cash";
}

/**
 * Pure: the admission's payer and its authorisation rows → the split's terms.
 * - The CURRENT chain is the rows from the last `payer_change` on (a payer change starts a new authorisation).
 * - State: the latest decision in the chain — a denial, else the latest approval (its running total), else pending
 *   when something was requested. A requested enhancement keeps the approved total until it is approved.
 * - Terms: the latest STATED value of each term in the chain; an SI cap needs the coverage's sum insured — without it
 *   no cap is applied and `room_rent_cap_unresolved` is raised (never a guessed cap). An absolute cap wins over a %.
 * - `cash_consent_missing`: a denial with no later approval (appeal) and no later payer change carrying a signed
 *   counselling document.
 */
export function splitTermsOf(
  payerKind: string | null, rows: readonly AuthRowInput[], sumInsuredPaise: number | null, schemeNonCoveredPaise: number,
): SplitTerms {
  const all = [...rows].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || (a.id < b.id ? -1 : 1));
  let from = 0;
  all.forEach((r, i) => { if (r.entry === "payer_change") from = i; });
  const chain = all.slice(from);
  let authState: AuthState = "none";
  let approved = 0;
  let preAuthNumber: string | null = null;
  let capPaise: number | null = null;
  let capBp: number | null = null;
  let coPayBp: number | null = null;
  for (const r of chain) {
    if (r.preAuthNumber !== null) preAuthNumber = r.preAuthNumber;
    if (r.roomRentCapPaise !== null) { capPaise = r.roomRentCapPaise; capBp = null; }
    if (r.roomRentCapSiBp !== null) { capBp = r.roomRentCapSiBp; capPaise = null; }
    if (r.coPayBp !== null) coPayBp = r.coPayBp;
    if (isDenial(r)) { authState = "denied"; approved = 0; }
    else if (APPROVED.has(r.status)) { authState = "approved"; approved = r.approvedTotalPaise; }
    else if (authState === "none") authState = "pending";
  }
  const exceptions: IpdSplitException[] = [];
  let roomRentCapPaise = capPaise;
  if (capPaise === null && capBp !== null) {
    if (sumInsuredPaise === null || sumInsuredPaise <= 0) exceptions.push("room_rent_cap_unresolved");
    else roomRentCapPaise = Math.floor((sumInsuredPaise * capBp) / 10_000);
  }
  // Review $9: an approval after the denial (the appeal) reinstates insurance — the denial no longer stands, and no
  // cash consent is owed. Otherwise the consent is a later payer change carrying the signed counselling document.
  const lastDenial = all.map((r, i) => (isDenial(r) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
  const after = lastDenial < 0 ? [] : all.slice(lastDenial + 1);
  // A payer change is not an appeal: it moves to another payer (or cash) and needs its own consent.
  const appealed = after.some((r) => APPROVED.has(r.status) && r.entry !== "payer_change");
  const deniedEver = lastDenial >= 0 && !appealed;
  if (deniedEver && !after.some((r) => r.entry === "payer_change" && r.counsellingDocumentId !== null)) {
    exceptions.unshift("cash_consent_missing");
  }
  return {
    mode: splitModeOf(payerKind), authState, preAuthNumber, approvedTotalPaise: approved, roomRentCapPaise, coPayBp,
    deniedEver, exceptions, schemeNonCoveredPaise,
  };
}

/**
 * The room-rent cap warning for one class (pure): null when no cap applies, the class is critical care, or the rent is
 * within the cap. Words are one short line for the class card and the upgrade consent.
 */
export function capWarningOf(
  cls: IpdBedClass, capPerDayPaise: number | null, rentPerDayPaise: number | null,
): { targetClass: IpdBedClass; capPerDayPaise: number; rentPerDayPaise: number; overPerDayPaise: number; payerShareBp: number; words: string } | null {
  if (capPerDayPaise === null || rentPerDayPaise === null || rentPerDayPaise <= capPerDayPaise || CAP_EXEMPT_CLASSES.has(cls)) return null;
  const payerShareBp = Math.floor((capPerDayPaise * 10_000) / rentPerDayPaise);
  const over = rentPerDayPaise - capPerDayPaise;
  return {
    targetClass: cls, capPerDayPaise, rentPerDayPaise, overPerDayPaise: over, payerShareBp,
    words: `Over cap by ${rupeeText(over)}/day; insurer pays ${pctText(payerShareBp)} of nursing, RMO, visits`,
  };
}
