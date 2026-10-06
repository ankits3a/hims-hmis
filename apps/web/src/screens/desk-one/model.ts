import type { CounterSequence, TokenLane, WireDoctorSummary } from "../../lib/opd-api";
import type { DeptQueue as SharedDeptQueue, Lane } from "../../../../../packages/contracts/src/desk-counter";

/*
  THE LANES, THE TOKEN'S STATES, TODAY'S OPEN VISIT, THE MONEY READ, THE QUEUE READ, THE TOKEN LABEL
  AND AN AGE live in packages/contracts/src/desk-counter.ts since 2026-10-06 — the phone's Desk One
  (mobile M4) reads the same file. Every name this module exported is still exported here.
*/
export {
  LANES, laneOf, flowOf, tokenStateOf, openVisitsToday, shouldJoinNow, rs, billOf, invoiceLinesOf,
  waitMinutes, vitalsAhead, inHall, bookableToday, deptQueues, shortestLine, firstFreeDoctor,
  tokenLabel, ageYearsOf, ageOf, sexLetter, initialsOf,
} from "../../../../../packages/contracts/src/desk-counter";
export type { Lane, TokenState, OpenVisit, BillLine } from "../../../../../packages/contracts/src/desk-counter";
/** The board's rows are the web's full `WireDoctorSummary` — the shared arithmetic reads a subset of it. */
export type DeptQueue = SharedDeptQueue<WireDoctorSummary>;

/**
 * ═══ DESK ONE — THE MODEL, AND EVERYTHING IN IT IS PURE ═══
 *
 * The screen's every branch that a test can be written against lives here rather than inside a
 * component: the lane mapping, the stage order, the money read, the token stamp. RC-3's close
 * review is the reason — 13 mutants died against the COMPONENTS while three CRITICALs sat in the
 * assembly, because the assembly's decisions were expressed as JSX conditions no test could name.
 */


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

/* ══════════ FD-26 · seats ══════════ */

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-26 — THE SAME DESK, SHOWN ONE STAGE AT A TIME, BECAUSE THE HOSPITAL STAFFS THREE CHAIRS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's instruction, 2026-09-06: *"just like Desk One screen which has all three screens in
 * one URL, we need to have the same 3 screen but on different URL too… Just mimic the Desk One
 * screen but bifurcated in three. Don't change the UX or UI, keep as it is… the current build has
 * made it worse."*
 *
 * FD-25 answered the same instruction by BUILDING THREE MORE SCREENS — `registration.tsx`,
 * `appointment.tsx` — each a fresh re-draw of a stage Desk One already had. Screenshots of the
 * shipped result are what "worse" means, and they are worth writing down because a copy always
 * looks cheap on the day it is written:
 *
 *   · `/registration`'s hit row lost the initials tile, the `restricted` pill, the FD-11
 *     district / on-file-since line that exists to tell eight Ramesh Kumars apart, the first-row
 *     ring and the Enter binding. Its duplicate panel lost "this is them" ENTIRELY, so a clerk who
 *     recognised the duplicate had no door but "register anyway".
 *   · `/registration` grew a doctor dropdown INSIDE the registration form — the exact thing the
 *     owner rejected by name in FD-8 ("the appointment is a STAGE, not a field").
 *   · `/appointment` dropped the whole WALK-IN half. The owner's "(Walkin/Future)" is that half
 *     asked for back.
 *   · All three sat under the app nav, which on this deployment wraps to three rows and, with the
 *     mode banner and a screen-title row, spends ~200px before the work starts.
 *
 * A SEAT IS A PROJECTION OF DESK ONE, NOT A FOURTH COPY. One component, one prop. `counter` is the
 * identity: every branch downstream reads `seat === "counter" ? <what shipped> : <the seat's>`, so
 * the screen the owner signed off is textually unchanged and a revert pair on any seat branch
 * leaves `/counter` green.
 */
export type Seat = "counter" | "registration" | "appointment" | "billing";

export const SEATS: readonly Seat[] = ["registration", "appointment", "billing"];

/** The steps a seat draws in its flow strip, and the only stages it may show. */
export const SEAT_STEPS: Record<Seat, readonly { stage: Stage; label: string }[]> = {
  counter: STEPS,
  registration: [{ stage: "register", label: "Register" }],
  appointment: [{ stage: "appointment", label: "Appointment" }],
  billing: [{ stage: "bill", label: "Bill" }],
};

/** Where each seat lives, so a desk can consume `?new` against its OWN route rather than `/counter`. */
export const SEAT_ROUTE: Record<Seat, string> = {
  counter: "/counter",
  registration: "/registration",
  appointment: "/appointment",
  billing: "/billing",
};

/** What the header calls each seat. `counter` is the one that names all three, because it is all three. */
export const SEAT_LABEL: Record<Seat, string> = {
  counter: "Desk One",
  registration: "Registration",
  appointment: "Appointment",
  billing: "Billing",
};

/** Where a stage sits in the desk's one-way flow. `find` and `done` are the ends and unordered. */
const FLOW_ORDER: readonly Stage[] = ["register", "appointment", "bill"];

/**
 * ═══ WHAT A SEAT DOES WITH A STAGE IT DOES NOT HAVE, AND WHY IT IS NOT ONE ANSWER ═══
 *
 * The desk proposes stages by NAME — `hold` proposes `appointment`, `assign` proposes `bill`,
 * `enrol` proposes `appointment` — and those names are Desk One's flow, not the seat's. A seat has
 * exactly one working stage, so every proposal is either behind it, on it, or past it, and the
 * three mean different things:
 *
 *   BEHIND  → the seat's own stage. The billing chair being handed a patient (`hold` proposes
 *             `appointment`) means "this person is in front of me" and the honest landing is the
 *             bill, not a screen saying the job is finished before it started.
 *   ON      → itself.
 *   PAST    → `done`. The registration chair that just enrolled somebody (`enrol` proposes
 *             `appointment`) HAS finished; the patient walks to the booking desk.
 *
 * Collapsing the first two into `done` was the first version of this function and it was wrong in
 * the direction that hurts: it made the billing seat unable to hold a patient at all.
 *
 * `counter` short-circuits to the identity, and that is asserted directly in the suite rather than
 * left to follow from the table below — a table gets edited and an identity does not.
 */
export function stageForSeat(seat: Seat, proposed: Stage): Stage {
  if (seat === "counter") return proposed;
  if (proposed === "find" || proposed === "done") return proposed;
  const mine = SEAT_STEPS[seat][0];
  if (mine === undefined) return "done";
  const here = FLOW_ORDER.indexOf(mine.stage);
  const there = FLOW_ORDER.indexOf(proposed);
  return there > here ? "done" : mine.stage;
}

/** True when this seat runs the named stage at all. The palette and `startEnrolment` ask it. */
export function seatHasStage(seat: Seat, stage: Stage): boolean {
  return seat === "counter" || SEAT_STEPS[seat].some((s) => s.stage === stage);
}

/** `stepIndex`, but over the seat's own list. Identical to `stepIndex` for `counter`. */
export function seatStepIndex(seat: Seat, stage: Stage): number {
  const steps = SEAT_STEPS[seat];
  if (stage === "done") return steps.length;
  const i = steps.findIndex((s) => s.stage === stage);
  return i < 0 ? 0 : i;
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
