import { dismissCopilotNotice, getCopilotNotice } from "./copilot-api";

/**
 * ═══ THE COPILOT STAFF NOTICE (owner ruling 2026-10-10: notice first; E0.1, decision 0064) ═══
 *
 * Every copilot question is recorded in the ledger for 180 days, and staff are data principals
 * under the DPDP Act. So before a person's first question they are told, in one line, and the
 * server remembers that they dismissed it (`copilot_notice_acks`) — on any computer, for good.
 *
 * ONE STORE, ONE HOST. Thirteen screens ask through `useCopilot`, some in an `AgentDock` and some
 * not, so the notice is not drawn by any of them: `useCopilot` asks the store to check when its
 * screen mounts, and the host mounted once at the root draws the card. The ask is NOT blocked —
 * the card is up before the box can be used, and the ledger records every ask either way.
 *
 * A failed read shows nothing and is retried on the next check: the desk is never stopped by it.
 * The phone app (E1.3, `apps/mobile/src/screens/copilot.tsx`) reads and dismisses the same server state.
 */
export type NoticeState = "unknown" | "checking" | "seen" | "showing";
type State = NoticeState;

let state: State = "unknown";
const listeners = new Set<() => void>();
function set(next: State): void { state = next; for (const l of listeners) l(); }

/** Called by `useCopilot` on mount and before each ask. Reads the server at most once per page load. */
export function checkCopilotNotice(): void {
  if (state !== "unknown") return;
  set("checking");
  getCopilotNotice().then(
    (r) => { set(r.seen ? "seen" : "showing"); },
    () => { set("unknown"); },
  );
}

export function dismissNotice(): void {
  set("seen");
  /* If the write fails the card is gone for this page only; the next page load asks again. */
  dismissCopilotNotice().catch(() => { state = "unknown"; });
}

/** Tests only. */
export function resetCopilotNoticeForTests(): void { state = "unknown"; }

export function subscribeCopilotNotice(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function copilotNoticeState(): NoticeState { return state; }
