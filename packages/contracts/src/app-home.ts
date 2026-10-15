/**
 * THE STAFF APP'S FIRST SCREEN — "My day" — AS ONE SET OF RULES (owner, 2026-10-07; decision record
 * 0042). Pure TypeScript with no imports, like `vitals-entry.ts`: the server reads it for the
 * deadlines it stamps on an approval, and the phone (outside the pnpm workspace) reads it by path.
 *
 * Three layers, top to bottom: NEEDS YOU NOW (waiting on this person, a clock running), MY DAY
 * (today's numbers), MY WORK (the screens). The rules of the first layer live here so the server and
 * the phone cannot disagree about what is late:
 *
 *   · an approval's deadline is a property of its KIND (`approvalDeadlineMinutes`);
 *   · a clock is neutral, then amber at half its time, then red when over (`toneOf`);
 *   · the oldest clock leads, red before amber before neutral, and five cards show (`orderNeeds`,
 *     `MAX_NEEDS`); the rest sit behind "See all (n)";
 *   · which approvals ask for the fingerprint first (`isMoneyApproval`).
 */

export type Tone = "neutral" | "amber" | "red";

/* ═══ deadlines ═══ */

/**
 * Owner 2026-10-07: "refunds and discounts 2 h, price changes 24 h, cover requests by the duty's
 * start". DECIDED for the kinds the ruling does not name, by the same test — is a patient standing
 * at a counter while this waits? Then 2 h (credit, an unpaid release, a deposit exception, a
 * restricted antimicrobial). Paperwork nobody is standing at a counter for gets 24 h (purchase
 * orders, payment runs, stock, definitions, merges). An unknown kind has NO deadline: it shows its
 * age only, which is true, rather than a made-up due time.
 */
export const APPROVAL_DEADLINE_MINUTES: Readonly<Record<string, number>> = {
  billing_discount: 120,
  billing_clearance_discount: 120,
  billing_refund: 120,
  billing_refund_owner: 120,
  billing_credit_extension: 120,
  billing_credit_owner: 120,
  billing_recon_charge_owner: 1440,
  billing_variance: 1440,
  lab_release_unpaid: 120,
  lab_release_unpaid_owner: 120,
  imaging_release_unpaid_owner: 120,
  ot_deposit_exception: 120,
  membership_grace_honor: 120,
  pharmacy_restricted_antimicrobial: 120,
  pharmacy_discount_incharge: 120,
  pharmacy_discount_owner: 120,
  tariff_revision: 1440,
  materials_po_approval: 1440,
  materials_po_approval_owner: 1440,
  materials_payment_run_approval: 1440,
  materials_stock_adjustment: 1440,
  materials_near_expiry_acceptance: 1440,
  materials_vendor_bank_change: 1440,
  imaging_definition_publish: 1440,
  ot_definition_publish: 1440,
  patient_merge: 1440,
  patient_unmerge: 1440,
};

export function approvalDeadlineMinutes(typeKey: string): number | null {
  return Object.prototype.hasOwnProperty.call(APPROVAL_DEADLINE_MINUTES, typeKey) ? APPROVAL_DEADLINE_MINUTES[typeKey]! : null;
}

/** When an approval of this kind, asked at `requestedAtMs`, is due. Null where the kind has no deadline. */
export function approvalDueAtMs(typeKey: string, requestedAtMs: number): number | null {
  const m = approvalDeadlineMinutes(typeKey);
  return m === null ? null : requestedAtMs + m * 60_000;
}

/**
 * Money leaves, or stops arriving, on a yes. These ask for the fingerprint (or the password) on a
 * phone before the decision is sent — owner 2026-10-07, "fingerprint before every money approval".
 * Any request that carries an amount is money, whatever its kind; a price change carries none and is.
 */
const MONEY_KINDS_WITHOUT_AMOUNT: readonly string[] = ["tariff_revision", "billing_credit_extension", "billing_variance", "materials_vendor_bank_change"];

export function isMoneyApproval(typeKey: string, amountPaise: number | null | undefined): boolean {
  if (typeof amountPaise === "number" && amountPaise > 0) return true;
  return MONEY_KINDS_WITHOUT_AMOUNT.includes(typeKey)
    || typeKey.startsWith("billing_") || typeKey.startsWith("materials_po") || typeKey.startsWith("materials_payment")
    || typeKey.startsWith("pharmacy_discount") || typeKey.endsWith("_release_unpaid") || typeKey.endsWith("_release_unpaid_owner");
}

/** How long a step-up (fingerprint or password) stays good for a money decision. */
export const STEP_UP_WINDOW_MS = 2 * 60_000;

/* ═══ the clock ═══ */

/**
 * `sinceMs` — when the waiting began. `dueMs` — when it is late, or null when nothing says.
 * Amber at half the time, red when over. With no deadline a clock is amber after `amberAfterMin`
 * and red after `redAfterMin` of plain waiting (a queue), or stays neutral when neither is given.
 */
export function toneOf(
  nowMs: number, sinceMs: number, dueMs: number | null,
  plain: { amberAfterMin?: number; redAfterMin?: number } = {},
): Tone {
  if (dueMs !== null) {
    if (nowMs >= dueMs) return "red";
    const half = sinceMs + (dueMs - sinceMs) / 2;
    return nowMs >= half ? "amber" : "neutral";
  }
  const waited = (nowMs - sinceMs) / 60_000;
  if (plain.redAfterMin !== undefined && waited >= plain.redAfterMin) return "red";
  if (plain.amberAfterMin !== undefined && waited >= plain.amberAfterMin) return "amber";
  return "neutral";
}

/** "2 h 5 min", "41 min", "0 min". Whole minutes, never negative. */
export type Span = { hours: number; minutes: number };
export function spanOf(ms: number): Span {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * What the clock SAYS, as an i18n key and its parts. With a deadline: "due in …" until it passes,
 * then "overdue …". Without: "waiting …". Colour never carries it alone.
 */
export type ClockWords = { key: "home.clock.waiting" | "home.clock.dueIn" | "home.clock.overdue" | "home.clock.startsIn" | "home.clock.started"; span: Span };
export function clockWords(nowMs: number, sinceMs: number, dueMs: number | null, kind: "wait" | "due" | "starts" = "wait"): ClockWords {
  if (kind === "starts" && dueMs !== null) {
    return nowMs >= dueMs ? { key: "home.clock.started", span: spanOf(nowMs - dueMs) } : { key: "home.clock.startsIn", span: spanOf(dueMs - nowMs) };
  }
  if (kind === "due" && dueMs !== null) {
    return nowMs >= dueMs ? { key: "home.clock.overdue", span: spanOf(nowMs - dueMs) } : { key: "home.clock.dueIn", span: spanOf(dueMs - nowMs) };
  }
  if (dueMs !== null && nowMs >= dueMs) return { key: "home.clock.overdue", span: spanOf(nowMs - dueMs) };
  return { key: "home.clock.waiting", span: spanOf(nowMs - sinceMs) };
}

/* ═══ needs you now ═══ */

export const MAX_NEEDS = 5;

export type NeedKind =
  | "approval" | "doctor_queue" | "held_medicine" | "paper_confirm" | "cover_request" | "next_duty"
  | "desk_waiting" | "rebook" | "vitals_recheck" | "vitals_bench" | "slips_waiting" | "papers_to_type"
  | "long_wait" | "roster_gap" | "my_request" | "sent_back"
  /** Owner 2026-10-09 — visits a desk let through unpaid. A COUNT on the card, never an amount (blind count, decision 0014). */
  | "to_collect";

export type Need = {
  /** Stable within a refresh: `<kind>:<id>`. A notification's link lands on it. */
  id: string;
  kind: NeedKind;
  /** When the waiting began (ms). */
  sinceMs: number;
  /** When it is late (ms), or null. */
  dueMs: number | null;
  tone: Tone;
};

const TONE_RANK: Record<Tone, number> = { red: 0, amber: 1, neutral: 2 };

/**
 * Red first, then amber, then neutral; inside a tone the OLDEST clock leads (a deadline that passed
 * longest ago, else the longest wait). Stable for equal keys, so a refresh does not shuffle cards.
 */
export function orderNeeds<T extends Need>(needs: readonly T[]): T[] {
  return needs
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const t = TONE_RANK[a.n.tone] - TONE_RANK[b.n.tone];
      if (t !== 0) return t;
      const ak = a.n.dueMs ?? Number.POSITIVE_INFINITY, bk = b.n.dueMs ?? Number.POSITIVE_INFINITY;
      if (ak !== bk) return ak - bk;
      if (a.n.sinceMs !== b.n.sinceMs) return a.n.sinceMs - b.n.sinceMs;
      return a.i - b.i;
    })
    .map((x) => x.n);
}

/** The five that show, and how many sit behind "See all (n)". */
export function capNeeds<T extends Need>(needs: readonly T[]): { shown: T[]; total: number; hidden: number } {
  const ordered = orderNeeds(needs);
  return { shown: ordered.slice(0, MAX_NEEDS), total: ordered.length, hidden: Math.max(0, ordered.length - MAX_NEEDS) };
}

/* ═══ thirty days ═══ */

export type DayPoint = { day: string; value: number };

/** The best day of a series (the latest one on a tie), or null when nothing was done at all. */
export function bestDay(series: readonly DayPoint[]): DayPoint | null {
  let best: DayPoint | null = null;
  for (const p of series) if (p.value > 0 && (best === null || p.value >= best.value)) best = p;
  return best;
}

/**
 * The sparkline's points in a `w` × `h` box, as x,y pairs — days with nothing are skipped (a Sunday
 * is not a collapse), so the line is one point per WORKING day.
 */
export function sparkPoints(series: readonly DayPoint[], w: number, h: number): { x: number; y: number }[] {
  const worked = series.filter((p) => p.value > 0);
  if (worked.length === 0) return [];
  const max = Math.max(...worked.map((p) => p.value));
  if (worked.length === 1) return [{ x: w, y: h - 4 - (worked[0]!.value / max) * (h - 10) }];
  return worked.map((p, i) => ({ x: (i / (worked.length - 1)) * w, y: h - 4 - (p.value / max) * (h - 10) }));
}

/** This week against the usual week, as a whole percent; null when there is no usual to compare with. */
export function percentAgainst(value: number, usual: number | null): number | null {
  if (usual === null || usual <= 0) return null;
  return Math.round(((value - usual) / usual) * 100);
}

/* ═══ the team card ═══ */

/**
 * Owner 2026-10-07: "supervisors see their team's by adding another card" — "unit heads, the
 * billing manager, the nursing in-charge, for their own people only". The roles a supervising role
 * sees (DECIDED from the seeded roles: there is no nursing in-charge role, so the OPD floor's
 * supervisor — `front_office_supervisor` — carries the front desk, the vitals desk, the slip desk
 * and the scribe). A unit head's people are the members of the units they head (the roster says).
 */
export const TEAM_ROLES: Readonly<Record<string, readonly string[]>> = {
  billing_manager: ["cashier"],
  front_office_supervisor: ["front_office", "vitals_desk", "opd_slip_desk", "opd_scribe"],
  pharmacy_incharge: ["pharmacy", "pharmacy_assistant"],
  ot_incharge: ["ot_nurse", "recovery_nurse"],
};
