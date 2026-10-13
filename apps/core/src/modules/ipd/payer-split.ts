import type { IpdBedClass, IpdPayerSplit, IpdRateComponent, IpdSplitException, IpdSplitLine, IpdSplitReason } from "@hmis/contracts";

/**
 * E2.2 (#726) — THE PAYER SPLIT ENGINE (spec SPEC-ipd-core §2 answer 5, §4.3; decision 0072 answer 5). PURE: lines,
 * the authorisation's state and terms, and the non-payables list in; per line payer paise, patient paise and reason
 * codes out. Nothing here reads a clock, a table or a price — every cap and amount is what the TPA desk typed.
 *
 * ORDER, per line (IRDAI practice, DECIDED):
 *   1. a reversed line and its reversal are both 0/0 (`reversed`) — the pair nets to nothing;
 *   2. the mode decides first: cash / reimbursement → all patient (`cash`, or `denied` after a denial); scheme → all
 *      payer (`scheme`); insured with the pre-auth denied → all patient (`denied`), still pending → all patient
 *      (`auth_pending`) until the insurer approves, and an approval covers the stay FROM ADMISSION (day-1 lines too);
 *   3. non-payables (service code or tariff category on the list) → all patient (`non_payable`);
 *   4. the room-rent cap, on a day whose room line's rent exceeds it and whose class is not critical care: the room
 *      line's excess is the patient's (`room_rent_over_cap`) and nursing, RMO and visits are paid in the ratio
 *      cap / rent, the rest the patient's (`room_rent_cap_proportional`). Pharmacy, consumables, implants and
 *      diagnostics are never proportionally deducted (IRDAI 2020);
 *   5. co-pay on what the payer still carries (`co_pay`) — after the cap;
 *   6. the approved amount, in posting order: whatever the payer's running total would carry beyond it is the
 *      patient's (`over_approved_amount`).
 * ROUNDING (DECIDED $): every payer share rounds DOWN to the paisa; the patient takes the remainder, so payer + patient
 * always equals the line exactly.
 */

/** Room classes exempt from the cap and the proportional deduction (DECIDED $: critical care, HDU included). */
export const CAP_EXEMPT_CLASSES: ReadonlySet<IpdBedClass> = new Set(["icu", "nicu", "picu", "hdu"]);
/** The components that scale with the room category and so take the proportional deduction (DECIDED, E2.2). */
export const PROPORTIONAL_COMPONENTS: ReadonlySet<IpdRateComponent> = new Set(["nursing", "rmo", "visit", "cross_visit"]);

export type SplitLineInput = {
  id: string;
  serviceDate: string;
  component: IpdRateComponent;
  billedClass: IpdBedClass | null;
  serviceCode: string;
  /** The tariff service's category (for the non-payables list); null when unknown. */
  category: string | null;
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
  /** A denial is on the record (the stay is cash from admission even after the payer moved to cash). */
  deniedEver: boolean;
  exceptions: IpdSplitException[];
  schemeNonCoveredPaise: number;
};

export type NonPayables = { services: ReadonlySet<string>; categories: ReadonlySet<string> };
export const NO_NON_PAYABLES: NonPayables = { services: new Set(), categories: new Set() };

const ORDER = (a: SplitLineInput, b: SplitLineInput): number =>
  a.serviceDate < b.serviceDate ? -1 : a.serviceDate > b.serviceDate ? 1
    : a.postedAt < b.postedAt ? -1 : a.postedAt > b.postedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Payer share of `net` in the ratio num/den, rounded down to the paisa. */
const share = (net: number, num: number, den: number): number => Math.floor((net * num) / den);

/** ₹ with Indian grouping; paise shown only when present. */
export function rupeeText(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Basis points as a percentage, two decimals at most ("50 %", "33.33 %"). */
export function pctText(bp: number): string {
  return `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} %`;
}

export function splitBill(lines: readonly SplitLineInput[], terms: SplitTerms, nonPayables: NonPayables = NO_NON_PAYABLES): IpdPayerSplit {
  const sorted = [...lines].sort(ORDER);
  const reversedIds = new Set(sorted.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  const dead = (l: SplitLineInput): boolean => l.reversalOf !== null || reversedIds.has(l.id);

  // The rent of each day: its live nightly room line.
  const rentOf = new Map<string, { rent: number; cls: IpdBedClass | null }>();
  for (const l of sorted) {
    if (l.component === "room" && l.source === "ipd.nightly" && !dead(l)) rentOf.set(l.serviceDate, { rent: l.netPaise, cls: l.billedClass });
  }
  const cap = terms.roomRentCapPaise;
  const cappedDay = (date: string): { rent: number; cap: number } | null => {
    const d = rentOf.get(date);
    if (cap === null || d === undefined || d.rent <= cap) return null;
    if (d.cls !== null && CAP_EXEMPT_CLASSES.has(d.cls)) return null;
    return { rent: d.rent, cap };
  };

  const totals = { payerPaise: 0, patientPaise: 0, nonPayablePaise: 0, capDeductionPaise: 0, coPayPaise: 0, overApprovedPaise: 0 };
  const out: IpdSplitLine[] = [];
  let carried = 0;
  const cappedDays = new Map<string, { rent: number; cap: number }>();
  const whole = (l: SplitLineInput, reason: IpdSplitReason, toPayer: boolean): IpdSplitLine =>
    ({ lineId: l.id, payerPaise: toPayer ? l.netPaise : 0, patientPaise: toPayer ? 0 : l.netPaise, reasons: [reason] });

  for (const l of sorted) {
    if (dead(l)) { out.push({ lineId: l.id, payerPaise: 0, patientPaise: 0, reasons: ["reversed"] }); continue; }
    let line: IpdSplitLine;
    if (terms.mode === "scheme") line = whole(l, "scheme", true);
    else if (terms.mode !== "insured") line = whole(l, terms.deniedEver ? "denied" : "cash", false);
    else if (terms.authState === "denied") line = whole(l, "denied", false);
    else if (terms.authState !== "approved") line = whole(l, "auth_pending", false);
    else if (nonPayables.services.has(l.serviceCode.toLowerCase()) || (l.category !== null && nonPayables.categories.has(l.category.toLowerCase()))) {
      line = whole(l, "non_payable", false);
      totals.nonPayablePaise += l.netPaise;
    } else {
      let payer = l.netPaise;
      const reasons: IpdSplitReason[] = [];
      const day = cappedDay(l.serviceDate);
      if (day !== null && l.component === "room") {
        payer = Math.min(l.netPaise, day.cap);
        reasons.push("room_rent_over_cap");
      } else if (day !== null && PROPORTIONAL_COMPONENTS.has(l.component)) {
        payer = share(l.netPaise, day.cap, day.rent);
        reasons.push("room_rent_cap_proportional");
      }
      if (day !== null) cappedDays.set(l.serviceDate, day);
      totals.capDeductionPaise += l.netPaise - payer;
      const bp = terms.coPayBp ?? 0;
      if (bp > 0 && payer > 0) {
        const kept = share(payer, 10_000 - bp, 10_000);
        totals.coPayPaise += payer - kept;
        payer = kept;
        reasons.push("co_pay");
      }
      const room = Math.max(terms.approvedTotalPaise - carried, 0);
      if (payer > room) {
        totals.overApprovedPaise += payer - room;
        payer = room;
        reasons.push("over_approved_amount");
      }
      carried += payer;
      line = { lineId: l.id, payerPaise: payer, patientPaise: l.netPaise - payer, reasons };
    }
    out.push(line);
    totals.payerPaise += line.payerPaise;
    totals.patientPaise += line.patientPaise;
  }
  if (terms.mode === "scheme") totals.patientPaise += terms.schemeNonCoveredPaise;

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
 * - `cash_consent_missing`: a denial with no later payer change carrying a signed counselling document.
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
  const lastDenial = all.map((r, i) => (isDenial(r) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
  const deniedEver = lastDenial >= 0;
  if (deniedEver && !all.slice(lastDenial + 1).some((r) => r.entry === "payer_change" && r.counsellingDocumentId !== null)) {
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
