/**
 * DOCTOR DESK DD-0 (#626) — the wire of `GET /doctor-desk/tower` and `GET /doctor-desk/briefs`, and the
 * reading rules both ends share (the brief's lifecycle, a clock's words). Pure TypeScript, no imports.
 *
 * Every sentence is a KEY and its params, never prose: the screen translates (en + hi), so a brief
 * line reads the same in both languages and can be traced to the fact that made it. Nothing in this
 * file carries money (decision 0058): no fee, paid, payer or price field exists on any shape here.
 */

/* ═══ the login brief's lifecycle (owner R9, 2026-09-18; plan D-I, D12) ═══ */

/** Highlighted this long after it was first shown, unless "Got it" first. */
export const BRIEF_HIGHLIGHT_MINUTES = 5;
/** On the Tower this long after it was first shown; after that only on the AI Briefs page. */
export const BRIEF_ON_TOWER_MINUTES = 60;
/**
 * A Tower read this long after the doctor's previous one is a return, and starts a new "since you
 * left" brief. DECIDED: three hours — a duty block, not a cup of tea or an hour in the consult room —
 * which is also longer than a brief stays on the Tower, so a return never replaces a brief still showing.
 */
export const BRIEF_GAP_MINUTES = 180;

export type BriefStage = "highlight" | "quiet" | "archived";

/** Where a brief stands at `now`. A brief never shown is highlighted (it is about to be). */
export function briefStage(b: { shownAt: string | null; seenAt: string | null }, now: Date | string): BriefStage {
  const t = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (b.shownAt === null) return "highlight";
  const age = t - Date.parse(b.shownAt);
  if (age >= BRIEF_ON_TOWER_MINUTES * 60_000) return "archived";
  if (b.seenAt !== null || age >= BRIEF_HIGHLIGHT_MINUTES * 60_000) return "quiet";
  return "highlight";
}

export type BriefKind = "login" | "morning" | "round";

/** One brief line: a template key, its params, and the record it came from (every line opens it). */
export type WireBriefFact = {
  key: string;
  params: Record<string, string | number>;
  /** The patient the line is about, resolved at READ time (the stored fact keeps only the id), or null for a count line. */
  patient: { id: string; uhid: string | null; name: string | null; restricted: boolean } | null;
  source: { module: "lab" | "radiology" | "opd"; ref: string } | null;
  href: string | null;
};

export type WireBrief = {
  id: string; kind: BriefKind; windowFrom: string; windowTo: string; createdAt: string;
  shownAt: string | null; seenAt: string | null; stage: BriefStage;
  /** Empty means a quiet spell — the screen says so; the brief is still kept. */
  facts: WireBriefFact[];
};

/* ═══ Needs Your Attention ═══ */

export const ATTENTION_KINDS = ["lab_critical", "imaging_critical", "lab_delta", "imaging_unread", "visit_open"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];
export const ATTENTION_TABS = ["critical", "change", "new", "pending"] as const;
export type AttentionTab = (typeof ATTENTION_TABS)[number];

export const ATTENTION_TAB_OF: Record<AttentionKind, AttentionTab> = {
  lab_critical: "critical",
  imaging_critical: "critical",
  lab_delta: "change",
  imaging_unread: "pending",
  visit_open: "pending",
};

export type WireAttentionRow = {
  /** `<kind>:<id>` — stable across reads. */
  key: string;
  kind: AttentionKind;
  tab: AttentionTab;
  patient: { id: string; uhid: string | null; name: string | null; restricted: boolean };
  /** e.g. `{ analyte: "Potassium", value: "6.4", unit: "mmol/L" }`, `{ study: "CT abdomen" }`, `{ date: "2026-10-14" }`. */
  params: Record<string, string>;
  at: string;
  /** A critical on a visit that is over — the patient has gone home (OpdDesk board). */
  goneHome: boolean;
  source: { module: "lab" | "radiology" | "opd"; ref: string };
  href: string;
  /** DD-1.3 — a lab critical the lab closed (read back) with no act recorded: it stays, amber. */
  acked?: boolean;
};

/* ═══ Clocks Running ═══ */

export type OwedKind = "alert" | "lab_critical" | "visit_open";

export type WireOwedRow = {
  /** `alert:<id>` · `lab_critical:<id>` · `visit:<id>` — what a nudge names. */
  key: string;
  kind: OwedKind;
  /** For an alert: its bell kind (`respond_overdue`, `imaging_chase`, …); for the others, the kind. */
  what: string;
  holder: { userId: string; name: string };
  since: string;
  dueAt: string;
  /** Whether the asker has already nudged this row (the button then reads Nudged). */
  nudgedByMe: boolean;
  /** DD-1.3 — a lab critical the lab has closed (read back) with no act recorded yet: amber, not red. */
  acked?: boolean;
  /** DD-1.2 — the row was moved to its holder by this person (newest move wins). */
  movedBy?: { userId: string; name: string } | null;
};

/** "3 min over" / "in 4 min" / "26 h over": the clock's words as a key and a number. */
export function owedClock(dueAt: string, now: Date | string): { key: "over" | "in"; minutes: number } {
  const t = typeof now === "string" ? Date.parse(now) : now.getTime();
  const d = Math.round((Date.parse(dueAt) - t) / 60_000);
  return d < 0 ? { key: "over", minutes: -d } : { key: "in", minutes: d };
}

/* ═══ the Tower ═══ */

export type WireDayLine = {
  userId: string; name: string;
  session: "none" | "not_started" | "in" | "out" | "closed";
  booked: number; seen: number; waiting: number; inConsult: number; longestWaitMinutes: number | null;
};

export type WireTeamMember = {
  userId: string; name: string;
  /** `head` · `faculty` · `senior_resident` · `junior_resident` … as the roster names it. */
  role: string;
  officiating: boolean;
  /** On a published duty now, and until when; null when off duty (D9: roster, never a tracked phone). */
  onDutyUntil: string | null;
  /** Owed rows this person holds now. */
  holds: number;
};

export type WireScheduleRow =
  | { kind: "duty"; startsAt: string; endsAt: string; night: boolean; positionKey: string; mode: string | null; dutyKind: string; activities: string[] }
  | { kind: "opd"; session: WireDayLine["session"]; booked: number; waiting: number };

export type WireAgentRun = { id: string; agent: string; outcome: "ok" | "failed"; summaryKey: string; params: Record<string, string | number>; ranAt: string };

export type WireTower = {
  at: string;
  istDate: string;
  /** `grade` is the roster grade (`professor`, `senior_resident` …) — the web says it via `doctorDesk.grade.*`. */
  you: { userId: string; name: string; grade: string | null };
  /** The doctor's unit on this IST day (membership at read time, plan D-C); null = no unit, own scope only. */
  unit: null | { teamId: string; name: string; short: string; departmentName: string };
  /** `opd_day` when the doctor has an OPD session today; otherwise the OPD tiles are absent, not zero. */
  mode: "opd_day" | "plain";
  tiles: { booked: number | null; seen: number | null; waiting: number | null; longestWaitMinutes: number | null; resultsToReview: number; papersToSign: number };
  attention: WireAttentionRow[];
  tabCounts: Record<"all" | AttentionTab, number>;
  /** The unit's doctors' OPD lines today (each unit doctor with a session). Empty without a unit. */
  unitOverview: WireDayLine[];
  clocks: WireOwedRow[];
  schedule: WireScheduleRow[];
  team: WireTeamMember[];
  /** The login brief while it is on the Tower (stage highlight or quiet); null once archived or when none. */
  brief: WireBrief | null;
  /** Briefs that have moved to the AI Briefs page and not been opened there — the menu's count. */
  briefsWaiting: number;
  agentRuns: WireAgentRun[];
};

export type WireBriefs = { briefs: WireBrief[] };

/* ═══ DD-0.8 — the OPD desk (OpdDesk.dc.html) ═══ */

/** "12 seen in 92 min · 7.7 min each · at this pace the line ends 13:25": the queue's facts, divided. */
export type WireOpdPace = { seen: number; sinceMinutes: number | null; eachMinutes: number | null; endsAt: string | null };

export type WireOpdDesk = {
  at: string;
  istDate: string;
  you: WireTower["you"];
  unit: WireTower["unit"];
  /** My OPD line today; null when I have no session (the screen then says so). */
  line: WireDayLine | null;
  pace: WireOpdPace;
  /** The unit's other doctors in OPD today, with their waiting. */
  colleagues: WireDayLine[];
  /** OPD-only "Waiting on you": unfinished visits, reports to open, criticals (gone home flagged). */
  waitingOn: WireAttentionRow[];
};

/** The NEXT token card: what four desks already entered, in the order the doctor asks for it. No suggestion, no money. */
export type WireNextCard = {
  encounterId: string;
  visitNo: string;
  visitType: string;
  patient: { id: string; uhid: string | null; name: string | null; restricted: boolean; ageYears: number | null; sex: string | null };
  /** 1 = first visit; 3 = third visit. */
  ordinal: number;
  complaint: null | { text: string; byName: string | null; at: string | null };
  vitals: null | {
    recordedAt: string; byName: string | null; today: boolean;
    sbp: number | null; dbp: number | null; pulse: number | null; weightKg: number | null; glucoseMgDl: number | null; spo2: number | null;
  };
  allergies: string[];
  /** The IST date of the patient's previous visit (with this doctor if any, else anyone), or null on a first visit. */
  lastSeen: string | null;
  since: { analyte: string; value: string | null; unit: string | null; flag: string | null; previous: string | null; at: string }[];
  lastRx: null | { issuedAt: string; lines: { drug: string; dose: string; frequency: string }[] };
};

/* ═══ DD-1 — the unit and the ladder (spec SPEC-doctor-desk-dd1-2026-10-16) ═══ */

/**
 * D11 — the scope a doctor's desk reads at, derived from the roster and grants, never chosen:
 * `own` (no unit) · `member` (her items) · `unit` (head, or officiating head inside the window) ·
 * `department` (HOD) · `hospital` (Medical Superintendent).
 */
export const DESK_LEVELS = ["own", "member", "unit", "department", "hospital"] as const;
export type DeskLevel = (typeof DESK_LEVELS)[number];
export type WireDeskScope = { level: DeskLevel; officiating: boolean; departmentId: string | null; departmentName: string | null };

/** D3 — "What did you do?" The loop closes on the act, not the tap. `other` needs a few words. */
export const ACT_CHOICES = ["seen_at_bedside", "ecg_ordered", "repeat_sample_sent", "treatment_started", "other"] as const;
export type ActChoice = (typeof ACT_CHOICES)[number];
export const ACT_NOTE_MAX = 200;

export type WireUnitOwedRow = WireOwedRow & { mayMove: boolean };

/** "Your people · this week": counts of acts, never of screens (D6). */
export type WirePersonWeek = {
  userId: string; name: string; role: string; officiating: boolean;
  onDutyUntil: string | null;
  /** Owed rows this person holds now. */
  open: number;
  /** OPD visits this person finished in the last 7 IST days, today included. */
  visitsDone: number;
  /** Median minutes from a lab critical opening to this person's recorded act, last 7 days; null when none. */
  criticalToActMedian: number | null;
  criticalActs: number;
  /** The asker's own last rating of this person's work, or null. */
  lastWord: null | { rating: WorkRating; workDate: string };
};

/** HOD / MS: one unit's counts, side by side. No patient, no person. */
export type WireUnitSummary = {
  teamId: string; name: string; short: string; departmentName: string;
  members: number; open: number; past: number; seenToday: number; criticalToActMedian: number | null;
};

export type WireUnitBoard = {
  at: string; istDate: string;
  you: WireTower["you"]; unit: WireTower["unit"]; scope: WireDeskScope;
  /** The unit's owed rows, oldest first (C26). */
  owed: WireUnitOwedRow[];
  /** Who a row may be moved to (current members). Empty when the asker may not move. */
  moveTo: { userId: string; name: string; role: string }[];
  people: WirePersonWeek[];
  /** Department or hospital scope: the units side by side. Empty below. */
  units: WireUnitSummary[];
};

/** SR phone "Now" (Main.dc.html, OPD/roster parts): NOW = criticals, TODAY = unread reports and unfinished visits. */
export type WireNow = {
  at: string; istDate: string;
  you: WireTower["you"]; unit: WireTower["unit"]; scope: WireDeskScope;
  now: WireAttentionRow[];
  today: WireAttentionRow[];
};

/** Professor phone: "Handled without you" — a unit critical someone else acted on. */
export type WireHandledRow = {
  key: string; analyte: string; value: string; unit: string;
  patient: WireAttentionRow["patient"];
  by: { userId: string; name: string };
  choice: ActChoice; minutes: number; actedAt: string;
};

export const WORK_RATINGS = ["good", "fine", "needs_rework"] as const;
export type WorkRating = (typeof WORK_RATINGS)[number];
export const RATING_REASON_MAX = 200;

/** A resident's finished work the asker may rate (DD-1: an OPD visit, today or yesterday). */
export type WireRateItem = {
  workKind: "opd_visit"; workId: string; visitNo: string; workDate: string;
  patient: WireAttentionRow["patient"];
  resident: { userId: string; name: string; role: string };
  completedAt: string | null;
  /** What the asker already gave, or null. */
  mine: WorkRating | null;
};

export type WireProfessor = {
  at: string; istDate: string;
  you: WireTower["you"]; unit: WireTower["unit"]; scope: WireDeskScope;
  /** Oldest first, the first few; `owedTotal` is the whole list (the unit board). */
  owed: WireOwedRow[];
  owedTotal: number;
  /** Owed rows past their time — the proactive line's count (shown only when proactive is ON). */
  past: number;
  handled: WireHandledRow[];
  toRate: WireRateItem[];
};

/** "My performance vs averages" (owner 2026-10-09): an average shows only above these floors. */
export const RATING_MIN_OWN = 5;
export const RATING_MIN_POOL_PEOPLE = 3;
export const RATING_MIN_POOL_RATINGS = 10;

/** A resident's own ratings this month, beside the department's and the hospital's share — no names. */
export type WireMyRatings = {
  month: string;
  counts: Record<WorkRating, number> & { total: number };
  /** Share rated Good, 0–100, or null below the floor. */
  share: { you: number | null; department: number | null; hospital: number | null };
  recent: { workDate: string; workKind: "opd_visit"; rating: WorkRating; reason: string | null }[];
};

/** Share rated Good, rounded, or null below `min` ratings. */
export function goodShare(good: number, total: number, min: number): number | null {
  return total < min || total === 0 ? null : Math.round((good * 100) / total);
}

/* ═══ DD-report v0 — the unit report at 08:00 IST (plan DD-R.1/R.2, D8, D-G) ═══ */

/** The report's instant: 08:00 IST, the take boundary. It covers the 24 h that ended then. */
export const UNIT_REPORT_IST = "08:00";

/**
 * One unit's report for one take day. COUNTS ONLY: no patient, no UHID, no person's name (D8). A median
 * is null below its floor — the unit's own needs `RATING_MIN_OWN` acts; the department's and the
 * hospital's need `RATING_MIN_POOL_PEOPLE` units contributing and `RATING_MIN_POOL_RATINGS` acts.
 */
export type WireUnitReport = {
  id: string;
  teamId: string; unitName: string; short: string; departmentName: string;
  /** The IST date of the 08:00 the report was made at. */
  reportDate: string;
  windowFrom: string; windowTo: string; sentAt: string;
  critical: { acts: number; median: number | null; over: number; longest: number | null; overMinutes: number };
  compare: { department: number | null; hospital: number | null };
  /** OPD on the IST day before the report date. */
  opd: { date: string; seen: number; doctors: number };
  /** What the unit owed at 08:00, and how much of it was past its time; criticals still without an act. */
  owed: { open: number; past: number; criticalsWithoutAct: number };
};

export type WireUnitReports = { scope: WireDeskScope; reports: WireUnitReport[] };
