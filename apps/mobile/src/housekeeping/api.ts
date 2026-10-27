import { ApiError } from "../api";
import type { useSession } from "../session";

/**
 * HK-2 (#974) — the housekeeping doors the staff app uses: the SAME doors as HK-1's web phone screens
 * (apps/core/src/modules/housekeeping/housekeeping.controller.ts and the task engine's `/tasks/...`). Shapes are copied
 * from packages/contracts (housekeeping.ts, tasks.ts): the app is not in the workspace and imports nothing from it.
 */
type Call = ReturnType<typeof useSession>["call"];

export type HkTaskCard = {
  id: string; kind: string; label: string; state: string; placeName: string | null; floorName: string | null;
  dueAt: string; note: string | null; version: number;
};
export type HkMyTasks = { serverNow: string; mine: HkTaskCard[]; pool: HkTaskCard[] };
export type HkWorkForm = { taskId: string; needsWork: boolean; areaName: string | null; items: { id: string; text: string }[]; photoNeeded: boolean; lastReason: string | null };
export type HkToCheck = { taskId: string; kind: string; kindLabel: string; placeName: string | null; doneAt: string | null; terminal: boolean; fails: number };
export type HkProof = {
  taskId: string; attempt: number; doneByName: string; company: string; scannedAt: string; scanAreaName: string | null;
  answers: { text: string; ok: boolean }[]; photo: { mimeType: string; imageBase64: string } | null; fails: number; lastReason: string | null;
};
type Ack = { id: string; state: string; version: number };

/** The housekeeping kinds an attendant works with a checklist (the contract's list, copied). */
export const HK_WORKED_KINDS: ReadonlySet<string> = new Set([
  "bed_clean_routine", "bed_clean_terminal", "spill", "area_request", "area_round_checked", "area_round", "area_rework",
]);
/** The contract's `HK_FAIL_REASONS`, copied; the words are translated on screen. */
export const HK_FAIL_REASONS = ["Floor wet", "Bin full", "Linen missing", "Stain", "Smell", "Toilet dirty"] as const;

const enc = encodeURIComponent;
export function hkApi(call: Call) {
  return {
    mine: () => call<HkMyTasks>("GET", "/tasks/mine"),
    accept: (id: string) => call<Ack>("POST", `/tasks/${enc(id)}/accept`, {}),
    start: (id: string) => call<Ack>("POST", `/tasks/${enc(id)}/start`, {}),
    form: (id: string) => call<HkWorkForm>("GET", `/housekeeping/tasks/${enc(id)}/work-form`),
    photo: (id: string, mimeType: string, imageBase64: string) => call<{ photoKey: string }>("POST", `/housekeeping/tasks/${enc(id)}/photo`, { mimeType, imageBase64 }),
    finish: (id: string, scan: string, answers: { itemId: string; ok: boolean }[], photoKey?: string) =>
      call<Ack>("POST", `/housekeeping/tasks/${enc(id)}/work`, photoKey === undefined ? { scan, answers } : { scan, answers, photoKey }),
    toCheck: () => call<HkToCheck[]>("GET", "/housekeeping/to-check"),
    proof: (id: string) => call<{ proof: HkProof | null }>("GET", `/housekeeping/tasks/${enc(id)}/proof`),
    confirm: (id: string, result: "pass" | "fail", reason?: string) =>
      call<Ack>("POST", `/housekeeping/tasks/${enc(id)}/confirm`, reason === undefined ? { result } : { result, reason }),
  };
}

/** The door QR text: the token after `#` when the QR holds the door page's address. */
export function tokenFromScan(raw: string): string {
  const s = raw.trim();
  const hash = s.indexOf("#");
  return hash >= 0 ? s.slice(hash + 1) : s;
}

/** The server's own words for a refusal (`message` + `fix`), or null. */
export function hkRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body as { message?: unknown; fix?: unknown } | null;
  const words = [b?.message, b?.fix].filter((x): x is string => typeof x === "string" && x !== "");
  return words.length === 0 ? null : words.join(" ");
}
