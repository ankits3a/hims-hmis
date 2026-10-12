import { ApiError, api } from "./api";
import type { MyTasksView, TaskBoardView } from "@hmis/contracts";

/* ═══ E0.1 TASK ENGINE (issue #713) — `apps/core/src/modules/tasks/tasks.controller.ts`'s `/tasks…`. Every
 * act answers the task's id, state and version; the screens re-read their list. ═══ */

export type TaskAck = { id: string; state: string; version: number };

export const fetchMyTasks = () => api<MyTasksView>("GET", "/tasks/mine");
export const fetchTaskBoard = () => api<TaskBoardView>("GET", "/tasks/board");

const act = (verb: "accept" | "start" | "done" | "return", id: string, version: number) =>
  api<TaskAck>("POST", `/tasks/${encodeURIComponent(id)}/${verb}`, { version });
export const acceptTask = (id: string, version: number) => act("accept", id, version);
export const startTask = (id: string, version: number) => act("start", id, version);
export const doneTask = (id: string, version: number) => act("done", id, version);
export const cancelTaskApi = (id: string, version: number, reason: string) =>
  api<TaskAck>("POST", `/tasks/${encodeURIComponent(id)}/cancel`, { version, reason });

/** The refusal code a task door answered with, or null. The screen shows `tasks.refusal.<code>`. */
export function taskRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

/** Whole minutes past due; 0 when not yet due. */
export function lateMinutes(dueAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(dueAt)) / 60_000));
}
