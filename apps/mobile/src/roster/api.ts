import { ApiError, NetworkError } from "../api";
import type { WireCoverOptions, WireMyDuties, WireOnNowBoard } from "./rules";

/**
 * The server routes the roster's two phone screens use — the SAME ones the web screens call
 * (`roster-board.controller.ts`). Every route's door is `roster.read`; what a person may DO (ask a
 * cover, answer one, resolve a flag) is decided inside the server's own act check, and a refusal
 * comes back as a `code` this file turns into the web's sentence. Nothing here decides who is on.
 */
export type Call = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string) => Promise<T>;

const enc = encodeURIComponent;

export function rosterApi(call: Call) {
  return {
    /** `at` omitted is the server's now. */
    onNow: (at?: string) => call<WireOnNowBoard>("GET", `/roster/on-now${at === undefined ? "" : `?at=${enc(at)}`}`),
    myDuties: () => call<WireMyDuties>("GET", "/roster/my-duties"),
    coverOptions: (assignmentId: string) => call<WireCoverOptions>("GET", `/roster/duties/${enc(assignmentId)}/cover-options`),
    /** A cover; with `counterpartAssignmentId`, a swap (the duty they give back). */
    askCover: (b: { assignmentId: string; counterpartId: string; counterpartAssignmentId?: string }) => call<{ requestId: string }>("POST", "/roster/covers", b),
    answerCover: (requestId: string, accept: boolean, note?: string) => call<{ ok: true }>("POST", `/roster/covers/${enc(requestId)}/answer`, note === undefined || note.trim() === "" ? { accept } : { accept, note: note.trim() }),
    withdrawCover: (requestId: string) => call<{ ok: true }>("POST", `/roster/covers/${enc(requestId)}/withdraw`),
    raiseFlag: (b: { departmentId: string | null; userId: string | null; at: string; note: string }) => call<{ flagId: string }>("POST", "/roster/flags", b),
    resolveFlag: (flagId: string) => call<{ ok: true }>("POST", `/roster/flags/${enc(flagId)}/resolve`),
  };
}
export type RosterApi = ReturnType<typeof rosterApi>;

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * A refusal as a sentence IN THE READER'S LANGUAGE, from its `code` (`roster.refusal.<code>`) — the
 * web's own rule (`lib/roster-api.ts` `rosterErrorText`): 403 without a code is the board's "closed
 * to you"; a code with no sentence names itself so it can be reported; no signal says nothing changed.
 */
export function rosterRefusal(e: unknown, t: T): string {
  if (e instanceof NetworkError) return t("roster.refusal.network");
  if (!(e instanceof ApiError)) return t("roster.refusal.network");
  const body = e.body as { code?: unknown } | null | undefined;
  const code = body !== null && body !== undefined && typeof body.code === "string" ? body.code : null;
  if (code !== null) {
    const key = `roster.refusal.${code}`;
    const said = t(key);
    return said === key ? t("roster.refusal.other", { code }) : said;
  }
  if (e.status === 403) return t("rosterOnNow.forbidden");
  return t("roster.refusal.other", { code: String(e.status) });
}
