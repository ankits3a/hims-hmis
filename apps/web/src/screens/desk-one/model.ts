import type { CounterSequence, TokenLane, WireDoctorSummary, WireCounterFlow } from "../../lib/opd-api";
import type { WireFeeQuote, WirePricedLine } from "../../lib/billing-api";

/**
 * ═══ DESK ONE — THE MODEL, AND EVERYTHING IN IT IS PURE ═══
 *
 * The screen's every branch that a test can be written against lives here rather than inside a
 * component: the lane mapping, the stage order, the money read, the token stamp. RC-3's close
 * review is the reason — 13 mutants died against the COMPONENTS while three CRITICALs sat in the
 * assembly, because the assembly's decisions were expressed as JSX conditions no test could name.
 */

/* ══════════ §4 · the flow machine ══════════ */

/**
 * The artifact's three lanes, and the two server columns each one IS.
 *
 * `opd_config` carries `counter_sequence` (queue_first | bill_first) and `token_lane`
 * (token_first | token_on_payment) — two independent booleans, four combinations, of which the
 * artifact names three because the fourth (`bill_first` + `token_first`) is incoherent: a token
 * cannot precede a bill in a lane whose whole definition is that the bill comes first. The server
 * lets both columns be set independently, so `laneOf` must fold that fourth case onto F3 rather
 * than crash — a supervisor who sets it gets bill-first behaviour, which is what they asked for.
 */
export type Lane = "F1" | "F2" | "F3";

export const LANES: readonly Lane[] = ["F1", "F2", "F3"];

export function laneOf(flow: WireCounterFlow): Lane {
  if (flow.counterSequence === "bill_first") return "F3";
  return flow.tokenLane === "token_first" ? "F1" : "F2";
}

export function flowOf(lane: Lane): WireCounterFlow {
  switch (lane) {
    case "F1": return { counterSequence: "queue_first", tokenLane: "token_first" };
    case "F2": return { counterSequence: "queue_first", tokenLane: "token_on_payment" };
    case "F3": return { counterSequence: "bill_first", tokenLane: "token_on_payment" };
  }
}

/**
 * ═══ WHAT THE LOCK PILL SAYS, AND WHY IT IS NOT WHAT THE ARTIFACT DREW ═══
 *
 * The artifact drew F3 as `Register → Bill → Appointment` — three stages in a different order. It
 * cannot be built that way and stay honest about money, and the reason is a guard rather than a
 * limitation: the consultation fee is charged AGAINST AN ENCOUNTER (`charge-rules.ts:feeServiceFor`
 * reads `encounter.visitType`, and `gate.ts:feeCovered` matches invoice lines by `encounterId`).
 * Billing before the encounter exists means issuing an invoice with no `encounterId`, which leaves
 * the fee gate reading UNPAID for the visit that follows and the daily close reporting a charge
 * orphan (`daily-close.ts:299`). So `bill_first` is what the SERVER means by it (RC-4 T2): the
 * encounter opens with `join: "defer"`, the money is taken, and only then does
 * `POST /visits/:id/join-queue` allocate a position and print a token that is PAID because the
 * payment already happened.
 *
 * The three lanes therefore read `Register → Appointment → Bill` on the desk, and it is the TOKEN
 * that moves between them — which is the artifact's own information design: the dossier's token
 * block reads `held`, or `T-118 UNPAID`, or `T-118 PAID`, and those three states are exactly the
 * three lanes. Nothing is lost but a re-ordered breadcrumb; nothing is claimed that is false.
 */
export const LANE_TEXT: Record<Lane, { short: string; long: string; stage: string }> = {
  F1: {
    short: "REG→APPT→BILL · token first",
    long: "Register → Appointment → Bill — the slip prints at queueing stamped UNPAID; billing flips it to PAID on the hall board.",
    stage: "Token-first lane: the slip is out with an outlined UNPAID stamp — billing flips it to PAID on the hall board.",
  },
  F2: {
    short: "REG→APPT→BILL · token on payment",
    long: "Register → Appointment → Bill — the queue position is taken at once, the physical token is held until the bill settles.",
    stage: "Held lane: the position is taken now, but the slip releases only when the bill settles. The supervisor owns that switch — the lock pill up top.",
  },
  F3: {
    short: "REG→BILL→QUEUE · money first",
    long: "Register → Bill → Queue — the department is chosen, the money is taken, and only then is a position allocated. The token always leaves PAID.",
    stage: "Bill-first flow: no position and no token until the bill settles, and then the slip leaves the printer PAID.",
  },
};

/* ══════════ stages ══════════ */

export type Stage = "find" | "register" | "appointment" | "bill" | "done";

/** The three the dossier draws as steps. `find` is not one of them — it is the empty desk. */
export const STEPS: readonly { stage: Stage; label: string }[] = [
  { stage: "register", label: "Register" },
  { stage: "appointment", label: "Appointment" },
  { stage: "bill", label: "Bill" },
];

export function stepIndex(stage: Stage): number {
  if (stage === "done") return STEPS.length;
  const i = STEPS.findIndex((s) => s.stage === stage);
  return i < 0 ? 0 : i;
}

/* ══════════ the token's three states ══════════ */

export type TokenState =
  | { kind: "none" }
  /** There is a visit and deliberately no slip: F2 before payment (position taken), or F3 (neither). */
  | { kind: "held"; position: number | null }
  | { kind: "out"; tokenNo: number; paid: boolean };

/**
 * ═══ THE STAMP IS DERIVED, AND THE LANE DECIDES WHEN THE SLIP LEAVES THE PRINTER ═══
 *
 * `joinQueue` has NO settlement gate server-side, and that is correct rather than a hole: the PAID
 * stamp is computed from the encounter's fee status, never stored, so a token joined before payment
 * reads UNPAID *truthfully*. What the three lanes actually differ in is therefore two things, and
 * this function is where both live:
 *
 *   F1  the number is allocated AND the slip prints, stamped UNPAID; the bill flips the stamp.
 *   F2  the number is allocated (the position is taken, so arrival order is respected) and the
 *       SLIP IS HELD. `tokenNo` is NOT null here — the server joined the queue — which is why
 *       "held" cannot be inferred from a null token and the lane has to be an argument.
 *   F3  nothing is allocated at all until the money is in; `tokenNo` is null and `shouldJoinNow`
 *       is what later fills it.
 *
 * `moneyTaken` is the single predicate for "the money is in": settled, credit-extended, or a free
 * visit with nothing to collect. All three are lawful exits from the bill stage.
 */
export function tokenStateOf(
  lane: Lane,
  visit: { tokenNo: number | null } | null,
  moneyTaken: boolean,
): TokenState {
  if (visit === null) return { kind: "none" };
  if (visit.tokenNo === null) return { kind: "held", position: null };
  if (lane === "F2" && !moneyTaken) return { kind: "held", position: visit.tokenNo };
  return { kind: "out", tokenNo: visit.tokenNo, paid: moneyTaken };
}

/**
 * RC-4's `shouldJoinNow`, restated for this screen: the deferred join fires after the money and
 * only then. Pure, so the mutant that fires it early can be applied to this function alone.
 */
export function shouldJoinNow(
  lane: Lane,
  visit: { encounterId: string; tokenNo: number | null; joining: boolean } | null,
  moneyTaken: boolean,
): boolean {
  if (lane !== "F3") return false;
  if (visit === null || visit.joining) return false;
  if (visit.tokenNo !== null) return false;
  return moneyTaken;
}

/* ══════════ money ══════════ */

/** `₹3,720` — en-IN grouping, from paise, with no fractional part when it is whole rupees. */
export function rs(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export type BillLine = { label: string; paise: number; credit: boolean };

/**
 * ═══ THE LIVE BILL, READ OFF THE SERVER'S OWN PRICED DRAFT ═══
 *
 * §3 of the artifact: *"pricing is not a stage, it is a column … the arithmetic happened as chips
 * attached."* So this function does NO arithmetic of its own beyond a sum it can be checked
 * against: every line and every discount below is a field the pricing engine already decided, and
 * the total is `netPayablePaise` as the engine folded it — never a re-addition on the client.
 *
 * FD-7's CRITICAL is the reason for that discipline: a value lane discounted nothing because the
 * screen asserted an intermediate field instead of the amount. The amount is what is rendered here.
 */
export function billOf(quote: WireFeeQuote | null): { lines: BillLine[]; totalPaise: number; free: boolean } {
  if (quote === null) {
    return { lines: [{ label: "OPD consult — priced on assignment", paise: 0, credit: false }], totalPaise: 0, free: false };
  }
  if (quote.free || quote.draft === null) {
    const why = quote.freeReason;
    const label = why === null
      ? "review visit — nothing to collect"
      : `review visit — free till ${why.windowEndsOn}${why.doctorName === null ? "" : ` (${why.doctorName})`}`;
    return { lines: [{ label, paise: 0, credit: true }], totalPaise: 0, free: true };
  }
  const lines: BillLine[] = [];
  for (const line of quote.draft.lines) {
    lines.push({ label: line.serviceName, paise: line.grossPaise, credit: false });
    const won = line.winner;
    if (won !== null && line.discountPaise > 0) {
      lines.push({ label: won.reason, paise: -line.discountPaise, credit: true });
    }
  }
  const totals = quote.draft.totals;
  if (totals.cgstPaise + totals.sgstPaise > 0) {
    lines.push({ label: "GST", paise: totals.cgstPaise + totals.sgstPaise, credit: false });
  }
  if (totals.roundingPaise !== 0) {
    lines.push({ label: "rounding", paise: totals.roundingPaise, credit: totals.roundingPaise < 0 });
  }
  return { lines, totalPaise: totals.netPayablePaise, free: totals.netPayablePaise === 0 };
}

/** The invoice's own lines, taken from the quote the clerk was shown, so the two cannot disagree. */
export function invoiceLinesOf(draft: { lines: WirePricedLine[] }): { lineId: string; serviceId: string; qty: number }[] {
  return draft.lines.map((l) => ({ lineId: l.lineId, serviceId: l.serviceId, qty: l.qty }));
}

/* ══════════ the queue read ══════════ */

export type DeptQueue = {
  departmentId: string;
  departmentName: string;
  doctors: WireDoctorSummary[];
  /** The shortest line in the department, in minutes — the number a patient is actually told. */
  poolWaitMinutes: number;
  /** Waiting for a doctor in this department. */
  waiting: number;
  /** Waiting for the vitals bay in this department — ahead of a new walk-in, counted separately. */
  atVitals: number;
};

/**
 * §3 — *"Queue bars — one bar per doctor, marigold past six waiting; wait shown as minutes AND a
 * clock time, because patients ask 'kitne baje?'"* Both halves come from here: the wait is
 * `waitingCount × avgConsultMinutes`, which is the server's own pace term (`avgConsultMinutes` is
 * `NOT NULL DEFAULT 6` on the department, so there is no client-side fallback to drift).
 *
 * ═══ WHY `waitingVitalsCount` IS NOT IN THIS PRODUCT, AND IS SHOWN SEPARATELY INSTEAD ═══
 *
 * The board reports two queues per doctor: `waitingCount` (waiting for the DOCTOR) and
 * `waitingVitalsCount` (waiting for the vitals bay first). A patient at vitals will reach the
 * doctor before a walk-in seated now, so folding them in would give a longer and arguably truer
 * wait — and it would also SILENTLY DISAGREE with `lib/walk-in-routing.ts`, which is the shipped
 * routing rail and computes `waitingCount × avgConsultMinutes` under RC-3's D7. Two formulas for
 * one number is how a screen and a server come to quote different waits to the same patient.
 *
 * So this stays the rail's formula, and `vitalsAhead` below is rendered as its own labelled figure.
 * Both numbers are on the doctor's row and neither is a guess.
 */
export function waitMinutes(d: WireDoctorSummary): number {
  return d.waitingCount * d.avgConsultMinutes;
}

/** Waiting for the VITALS BAY, not for the doctor — ahead of a new walk-in, and shown as its own. */
export function vitalsAhead(d: WireDoctorSummary): number {
  return d.waitingVitalsCount;
}

/** Everybody in this doctor's part of the hall: the header's "N waiting" is the sum of these. */
export function inHall(d: WireDoctorSummary): number {
  return d.waitingCount + d.waitingVitalsCount;
}

export function bookableToday(d: WireDoctorSummary): boolean {
  return d.scheduledToday && d.doctor.active;
}

/** Group the summary by department, ordered by the shortest pool first: the desk's actual question. */
export function deptQueues(
  summaries: readonly WireDoctorSummary[],
  departments: readonly { id: string; name: string }[],
): DeptQueue[] {
  const byDept = new Map<string, WireDoctorSummary[]>();
  for (const s of summaries) {
    const list = byDept.get(s.doctor.departmentId) ?? [];
    list.push(s);
    byDept.set(s.doctor.departmentId, list);
  }
  const out: DeptQueue[] = [];
  for (const dept of departments) {
    const doctors = (byDept.get(dept.id) ?? []).filter((d) => d.doctor.active);
    if (doctors.length === 0) continue;
    const open = doctors.filter(bookableToday);
    const waits = open.map(waitMinutes);
    out.push({
      departmentId: dept.id,
      departmentName: dept.name,
      doctors: [...doctors].sort((a, b) => waitMinutes(a) - waitMinutes(b)),
      poolWaitMinutes: waits.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...waits),
      waiting: open.reduce((a, d) => a + d.waitingCount, 0),
      atVitals: open.reduce((a, d) => a + d.waitingVitalsCount, 0),
    });
  }
  return out;
}

/** The shortest open line in the building — the dock's answer to "kis line mein kam wait hai?". */
export function shortestLine(queues: readonly DeptQueue[]): DeptQueue | null {
  const open = queues.filter((q) => Number.isFinite(q.poolWaitMinutes));
  if (open.length === 0) return null;
  return open.reduce((a, b) => (a.poolWaitMinutes <= b.poolWaitMinutes ? a : b));
}

/** The doctor to assign to when the clerk picked a department and not a person: the shortest line. */
export function firstFreeDoctor(q: DeptQueue): WireDoctorSummary | null {
  const open = q.doctors.filter(bookableToday);
  if (open.length === 0) return null;
  return open.reduce((a, b) => (waitMinutes(a) <= waitMinutes(b) ? a : b));
}

/* ══════════ time, in the hospital's own zone ══════════ */

/** `09:40` in IST, whatever the browser's zone is. A desk clock in the wrong zone is a wrong clock. */
export function istClock(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(at);
}

/** `SUN 30 AUG`, IST, upper-case — the artifact's header format. */
export function istDateLabel(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short",
  }).format(at).toUpperCase().replace(/,/g, "");
}

/** The clock time a wait of `minutes` lands on — "called around 10:05". */
export function etaClock(minutes: number, at: Date = new Date()): string {
  return istClock(new Date(at.getTime() + minutes * 60_000));
}

/**
 * Age as a counter says it: a whole number of years, or months under one.
 *
 * ═══ THE FIRST TEN CHARACTERS, AND THAT IS A MEASURED FIX ═══
 *
 * The wire type says `dob: string | null` and the OPD convention is an IST calendar date
 * (`YYYY-MM-DD`) — but `GET /patients/search` returns the drizzle `date` column serialized as a
 * FULL ISO TIMESTAMP (`"2025-09-02T00:00:00.000Z"`), measured against the running preview. Appending
 * `T00:00:00Z` to that produces an unparseable string, `Invalid Date`, and every search row rendered
 * its age as an em dash. Slicing to ten characters accepts both shapes, which is what a client that
 * cannot change the serializer has to do.
 */
export function ageOf(dob: string | null): string {
  if (dob === null || dob === "") return "";
  const born = new Date(`${dob.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return "";
  const now = new Date();
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < born.getUTCMonth()
    || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) years -= 1;
  if (years < 1) {
    const months = Math.max(0, Math.round((now.getTime() - born.getTime()) / (30.44 * 86_400_000)));
    return `${String(months)}m`;
  }
  return String(years);
}

/** `M` / `F` / `O` from the server's `administrativeGender`, for the dossier's `38F` line. */
export function sexLetter(gender: string): string {
  const g = gender.toLowerCase();
  if (g.startsWith("m")) return "M";
  if (g.startsWith("f")) return "F";
  return "O";
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter((w) => w !== "").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

/* ══════════ the dock's log ══════════ */

export type LogKind = "did" | "ok" | "warn" | "err" | "you";
export type LogLine = { at: string; text: string; kind: LogKind };

/**
 * §5 — *"everything it does lands in the log with a timestamp."* The log is APPEND-ONLY and every
 * line records something that already happened on the server, never something the screen is about
 * to try: a log that narrates intentions is a log that lies the moment a request is refused.
 */
export function logged(log: readonly LogLine[], text: string, kind: LogKind = "did"): LogLine[] {
  return [{ at: istClock(), text, kind }, ...log].slice(0, 60);
}

/* ══════════ the lane a supervisor is allowed to change ══════════ */

export type CounterFlowFields = { counterSequence: CounterSequence; tokenLane: TokenLane };
