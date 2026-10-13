import { z } from "zod";

/**
 * E0.1 TASK ENGINE (issue #713, decision 0072, spec SPEC-ipd-companions §2) — the shared shape of a
 * task and of every intent on it. The server parses every intent's input with these schemas; the web
 * reads the wire types and the refusal table.
 *
 * A task is one unit of service work at a place: clean a bed, take a bag, move a patient. Owning
 * modules (housekeeping, bmw, transport …) declare their kinds; this engine runs every kind through
 * the same states, the same dispatch and the same escalation ladder.
 */

export const TASK_STATES = ["created", "assigned", "accepted", "in_progress", "done", "verified", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** Open = still owed work. `done` waiting for a verifier is NOT open: the worker's part is over. */
export const OPEN_TASK_STATES = ["created", "assigned", "accepted", "in_progress"] as const satisfies readonly TaskState[];
export const CLOSED_TASK_STATES = ["done", "verified", "cancelled"] as const satisfies readonly TaskState[];

export const TASK_PRIORITIES = ["routine", "urgent", "stat"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_ASSIGNEE_KINDS = ["person", "team", "machine"] as const;
export type TaskAssigneeKind = (typeof TASK_ASSIGNEE_KINDS)[number];

export const TASK_PROOFS = ["none", "tap", "photo", "scan", "weight"] as const;
export type TaskProofKind = (typeof TASK_PROOFS)[number];

/** Provenance of the request (spec IPD core §0B). */
export const TASK_SOURCES = ["person", "device", "copilot_draft", "agent", "import"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];
/** An event may also be the engine's own clock (`system`): re-dispatch, escalation, end of shift. */
export const TASK_EVENT_SOURCES = [...TASK_SOURCES, "system"] as const;
export type TaskEventSource = (typeof TASK_EVENT_SOURCES)[number];

export const TASK_ACTS = [
  "raised", "merged", "assigned", "redispatched", "accepted", "started", "done", "verified",
  "cancelled", "returned", "escalated",
] as const;
export type TaskAct = (typeof TASK_ACTS)[number];

const id = z.string().min(1).max(64);
const reason = z.string().trim().min(1).max(280);

export const taskProofSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap") }).strict(),
  z.object({ kind: z.literal("scan"), code: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("weight"), grams: z.number().int().positive().max(1_000_000) }).strict(),
  z.object({ kind: z.literal("photo"), documentId: id }).strict(),
]);
export type TaskProof = z.infer<typeof taskProofSchema>;

export const raiseTaskInput = z.object({
  kind: z.string().min(1).max(48),
  placeResourceId: id.nullable().optional(),
  patientId: id.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  /** ISO instant. Absent: now + the kind's done window. */
  dueAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().trim().max(280).optional(),
  source: z.enum(TASK_SOURCES).optional(),
  /** An owning module's key for the request (e.g. `resource-event:<seq>`): a second raise with it returns the first task. */
  sourceRef: z.string().trim().min(1).max(128).optional(),
  /** ISO instant the need arose (a bed's release). Absent: now. */
  raisedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type RaiseTaskInput = z.infer<typeof raiseTaskInput>;

/** `version` is optional optimistic concurrency: present and stale = refusal `stale`. */
const taskRef = { taskId: id, version: z.number().int().positive().optional() };
export const taskRefInput = z.object(taskRef).strict();
export type TaskRefInput = z.infer<typeof taskRefInput>;
export const assignTaskInput = z.object({ ...taskRef, userId: id }).strict();
export type AssignTaskInput = z.infer<typeof assignTaskInput>;
export const completeTaskInput = z.object({ ...taskRef, proof: taskProofSchema.optional() }).strict();
export type CompleteTaskInput = z.infer<typeof completeTaskInput>;
export const cancelTaskInput = z.object({ ...taskRef, reason }).strict();
export type CancelTaskInput = z.infer<typeof cancelTaskInput>;
export const returnTaskInput = z.object({ ...taskRef, reason: reason.optional() }).strict();
export type ReturnTaskInput = z.infer<typeof returnTaskInput>;
export const cancelPlaceInput = z.object({ placeResourceId: id, reason }).strict();
export type CancelPlaceInput = z.infer<typeof cancelPlaceInput>;

/**
 * Every refusal: a code, a sentence a worker can read, and the fix. The web shows `tasks.refusal.<code>`
 * from its locales (Hindi and English); these English lines are the server's message.
 */
export const TASK_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  unknown_kind: { sentence: "This kind of task is not known.", fix: "Pick a task kind from the list." },
  unknown_place: { sentence: "This place is not in the register.", fix: "Pick the bed, room or ward from the list." },
  unknown_worker: { sentence: "This person cannot take tasks.", fix: "Pick an active member of staff." },
  not_found: { sentence: "This task does not exist.", fix: "Refresh the list." },
  already_taken: { sentence: "Someone else took this task.", fix: "Refresh and pick another task." },
  not_on_duty: { sentence: "This person is not on duty now.", fix: "Take tasks during your rostered shift, or ask the supervisor to roster you." },
  wrong_skill: { sentence: "This task needs a different skill.", fix: "Leave it for the staff who do this work." },
  not_yours: { sentence: "This task is assigned to someone else.", fix: "Ask the supervisor to assign it to you." },
  wrong_state: { sentence: "This step does not fit the task's stage.", fix: "Refresh to see where the task stands." },
  not_open: { sentence: "This task is already finished or cancelled.", fix: "Refresh the list." },
  stale: { sentence: "This task changed while you were looking.", fix: "Refresh and try again." },
  proof_missing: { sentence: "This task needs proof before it is done.", fix: "Add the proof the task asks for." },
  no_verify_step: { sentence: "This kind of task has no check step.", fix: "Nothing to verify." },
  verifier_is_doer: { sentence: "The person who did a task cannot check it.", fix: "Ask another supervisor to check it." },
  not_permitted: { sentence: "You may not check this kind of task.", fix: "Ask a supervisor who may." },
  reason_required: { sentence: "Say why.", fix: "Type a short reason." },
  nudged_recently: { sentence: "This task was nudged a few minutes ago.", fix: "Wait five minutes, or call the supervisor." },
} as const satisfies Record<string, { sentence: string; fix: string }>;
export type TaskRefusalCode = keyof typeof TASK_REFUSALS;

/* ═══ wire shapes ═══ */

/** One task as a worker or the board sees it. Never a patient's name, never money. */
export type TaskCard = {
  id: string;
  kind: string;
  label: string;
  priority: TaskPriority;
  state: TaskState;
  placeResourceId: string | null;
  placeName: string | null;
  placeCode: string | null;
  floorName: string | null;
  note: string | null;
  dueAt: string;
  createdAt: string;
  assigneeId: string | null;
  assigneeName: string | null;
  proofNeeded: TaskProofKind;
  verifyRequired: boolean;
  mergedCount: number;
  escalatedRung: number;
  version: number;
};

export type MyTasksView = { serverNow: string; mine: TaskCard[]; pool: TaskCard[] };

export type BoardWorker = { userId: string; name: string; onDuty: boolean; open: number; inProgress: number };
export type BoardFloor = { floorId: string | null; floorName: string | null; tasks: TaskCard[] };
export type TaskBoardView = {
  serverNow: string;
  floors: BoardFloor[];
  workers: BoardWorker[];
  /** Done tasks waiting for a check. */
  toVerify: TaskCard[];
  /** Counted in the database over every open task, not over the rows sent. */
  counts: { open: number; late: number; pool: number; notShown: number };
};

/** A second nudge on one task inside this window is refused (`nudged_recently`): one bell, not a stream. */
export const TASK_NUDGE_WINDOW_MIN = 5;

/** Whole minutes past due at `now`; 0 when not late. Pure, shared by the board and its tests. */
export function minutesLate(dueAt: string | Date, now: Date): number {
  const due = typeof dueAt === "string" ? Date.parse(dueAt) : dueAt.getTime();
  return Math.max(0, Math.floor((now.getTime() - due) / 60_000));
}
