import { z } from "zod";
import type { TaskBoardView, TaskState } from "./tasks";

/**
 * E1.4 HOUSEKEEPING (issue #721, decision 0072, spec SPEC-ipd-companions §3) — bed turnover on the shared task
 * engine. A bed released into cleaning raises exactly one cleaning task; the bed becomes available only when that
 * task is verified (the verification runs the ipd beds seam in the same transaction). A terminal clean (isolation
 * bed, infection-control or deep-clean block, death or absconded discharge) is checked by the housekeeping
 * supervisor alone.
 */

export const HOUSEKEEPING_KINDS = {
  routine: "bed_clean_routine",
  terminal: "bed_clean_terminal",
  spill: "spill",
  inspection: "room_inspection",
} as const;
export type HousekeepingKind = (typeof HOUSEKEEPING_KINDS)[keyof typeof HOUSEKEEPING_KINDS];
/** Every kind housekeeping owns, in board order. */
export const HOUSEKEEPING_KIND_LIST: readonly HousekeepingKind[] = [
  HOUSEKEEPING_KINDS.terminal, HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.spill, HOUSEKEEPING_KINDS.inspection,
];
/** The two kinds that turn a bed over: their verification makes the bed available. */
export const BED_CLEAN_KINDS: readonly HousekeepingKind[] = [HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.terminal];

/** Targets (spec §3): routine turnover 45 min from release, terminal 90 min, spill 15 min. */
export const HOUSEKEEPING_TARGET_MIN = { routine: 45, terminal: 90, spill: 15 } as const;

const id = z.string().min(1).max(64);
export const cleanRefInput = z.object({ taskId: id, version: z.number().int().positive().optional() }).strict();
export type CleanRefInput = z.infer<typeof cleanRefInput>;

/** One bed's cleaning, as the Beds board and the supervisor see it. No patient, no money. */
export type BedCleanView = {
  bedId: string;
  taskId: string;
  kind: HousekeepingKind;
  terminal: boolean;
  /** created / assigned / accepted / in_progress = being cleaned; done = cleaned, waiting for the check. */
  state: TaskState;
  raisedAt: string;
  dueAt: string;
  /** Whole minutes since the task was raised (the bed's release), at `serverNow`. */
  minutes: number;
  late: boolean;
  /** "A. K." — the assignee's initials (never a full name on a wall), or null while in the pool. */
  assigneeInitials: string | null;
  escalatedRung: number;
  version: number;
};
export type BedCleansView = { serverNow: string; cleans: BedCleanView[] };

/** The housekeeping supervisor's board: the task board over housekeeping's kinds only. */
export type HousekeepingBoardView = TaskBoardView;

export const HOUSEKEEPING_ROUTES = {
  bedCleans: "/housekeeping/bed-cleans",
  board: "/housekeeping/board",
  verify: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/verify`,
  nudge: (taskId: string) => `/housekeeping/cleans/${encodeURIComponent(taskId)}/nudge`,
} as const;

/** Housekeeping's own refusals (the engine's `TASK_REFUSALS` cover the rest): the rule and the fix. */
export const HOUSEKEEPING_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  not_a_clean: { sentence: "This is not a housekeeping task.", fix: "Open it from the task board." },
  terminal_needs_supervisor: {
    sentence: "A terminal clean is checked by the housekeeping supervisor (infection control).",
    fix: "Ask the housekeeping supervisor to check this bed.",
  },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type HousekeepingRefusalCode = keyof typeof HOUSEKEEPING_REFUSALS;
