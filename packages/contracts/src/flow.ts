/**
 * ═══ HOW LONG PATIENTS WAIT — DESK → VITALS → DOCTOR (owner 2026-10-09) ═══
 *
 * "I want to track how much time its being taken by hospital to get the patient from registration desk
 * to Vital desk and then how much time it is taking for a patient from vitals to getting consulted."
 *
 * Pure TypeScript with no imports, like `owner-app.ts`: the server builds these shapes and the phone
 * (outside the pnpm workspace) reads them by path. Every wait is in MINUTES, one decimal. No patient and
 * no member of staff is named anywhere in a payload — a department's name is the only name sent.
 *
 * THE THREE LEGS, from stored timestamps only:
 *   deskToVitals    `opd_encounters.opened_at` → the visit's FIRST `opd_vitals.recorded_at`
 *   vitalsToDoctor  that first save → `opd_encounters.consult_started_at`
 *   deskToDoctor    the two added, for a visit that has both
 *
 * AND ONE DURATION, NOT A WAIT (owner 2026-10-09, added after the three):
 *   consult         `consult_started_at` → `consult_completed_at`, for a visit the doctor completed ON A
 *                   SCREEN (`status = 'completed'`, `completed_via` null) — the same rule as My pace.
 *                   It is never added into `deskToDoctor`.
 */

export type FlowLeg = "deskToVitals" | "vitalsToDoctor" | "deskToDoctor" | "consult";
export const FLOW_LEGS: readonly FlowLeg[] = ["deskToVitals", "vitalsToDoctor", "deskToDoctor", "consult"];

/** A cell is shown only when this many visits are in it; below it the figures are null ("—"). */
export const FLOW_MIN_N = 5;
/** The by-hour strip: 08 to 20 IST, both ends shown. */
export const FLOW_FIRST_HOUR = 8;
export const FLOW_LAST_HOUR = 20;

export type FlowGroupBy = "department" | "day" | "hour" | "weekday";
export const FLOW_GROUP_BYS: readonly FlowGroupBy[] = ["department", "day", "hour", "weekday"];

/** `n` visits; `avg`, `median`, `p90` in minutes — all three null when `n` is under `FLOW_MIN_N`. */
export type FlowStat = { n: number; avg: number | null; median: number | null; p90: number | null };
export type FlowCell = Record<FlowLeg, FlowStat>;

/** Why a visit's wait was left out — counted, never listed. */
export type FlowDrops = {
  /** A guardian came alone (`patient_absent_at`): nobody to weigh. */
  guardian: number;
  /** The visit was abandoned, or its token left the line. */
  left: number;
  /** Closed from paper with no start time of its own (the start is the filing). */
  paperNoStart: number;
  /** Sent back through the line with results: the start on record is the second one. */
  reEntry: number;
  /** A wait under zero or over `FLOW_MAX_WAIT_MIN` minutes — a clock or a data slip. */
  outOfRange: number;
};

export type FlowGroup = {
  /** department: its id · day: 'YYYY-MM-DD' · hour: '08'..'20' · weekday: '0' (Monday) .. '6' (Sunday). */
  key: string;
  /** A department's name; null for the other groupings (the phone words them). */
  name: string | null;
  cell: FlowCell;
};

export type FindingType = "bay_peak" | "doctor_start_late" | "dept_outlier" | "week_regression" | "consult_up";
export const FINDING_TYPES: readonly FindingType[] = ["bay_peak", "doctor_start_late", "dept_outlier", "week_regression", "consult_up"];
export type FindingState = "open" | "dismissed" | "resolved";

/** What the phone shows of one finding: numbers and codes only — the words are the phone's fixed templates. */
export type FlowFinding = {
  id: string;
  type: FindingType;
  /** Null: the whole hospital. */
  departmentId: string | null;
  department: string | null;
  leg: FlowLeg;
  /** 0 = Monday … 6 = Sunday; null when the finding is not about one weekday. */
  weekday: number | null;
  hourFrom: number | null;
  hourTo: number | null;
  observed: number;
  baseline: number;
  patients: number;
  minutesLost: number;
  firstSeen: string;
  lastSeen: string;
  state: FindingState;
  /** "Tried it": the day it was pressed, the median then, and the median since (null until a night has passed). */
  triedOn: string | null;
  before: number | null;
  after: number | null;
  /** Resolved: the day, and minutes won = (before − after) × the patients since. */
  resolvedOn: string | null;
  minutesWon: number | null;
};

export type FlowReport = {
  from: string; to: string;
  groupBy: FlowGroupBy | null;
  departmentId: string | null;
  hospital: FlowCell;
  /** The like period before (same weekday last week · last week to date · last month to date); null when none. */
  previous: ({ from: string; to: string } & FlowCell) | null;
  groups: FlowGroup[];
  drops: FlowDrops;
  /** Open findings, worst first (minutes lost). Empty when the learning is switched off. */
  findings: FlowFinding[];
  /** Resolved in the last 90 days. */
  fixed: FlowFinding[];
  /** Whether this reader may press × and "Tried it" (the owner and the Medical Superintendent). */
  mayAct: boolean;
  /** Whether the nightly learning is switched on (`FLOW_FINDINGS_ENABLED`). */
  learning: boolean;
};

/** Whole minutes for a screen: "18". Null stays null. */
export function minutesShown(m: number | null | undefined): string | null {
  return m === null || m === undefined ? null : String(Math.round(m));
}

/** The variables a finding's fixed template is filled with — every one a number or a short code. */
export function findingVars(f: Pick<FlowFinding, "weekday" | "hourFrom" | "hourTo" | "observed" | "baseline" | "patients">): {
  dayKey: string; from: string; to: string; min: number; usual: number; pct: number; n: number;
} {
  const two = (h: number | null): string => (h === null ? "" : String(h).padStart(2, "0"));
  return {
    dayKey: f.weekday === null ? "" : `owner.wait.weekday.${String(f.weekday)}`,
    from: two(f.hourFrom), to: two(f.hourTo),
    min: Math.round(f.observed), usual: Math.round(f.baseline),
    pct: f.baseline > 0 ? Math.round(((f.observed - f.baseline) / f.baseline) * 100) : 0,
    n: f.patients,
  };
}
