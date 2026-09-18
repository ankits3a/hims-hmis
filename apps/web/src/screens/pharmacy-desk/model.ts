import type { WireDispense, WirePatientSummary, WireQueueRow } from "../../lib/pharmacy-api";

/**
 * ═══ PHASE PD — THE PHARMACY DESK'S PURE HALF ═══
 *
 * Everything the desk DERIVES, with no fetch and no React, so the rules a pharmacist reads off the
 * screen are tested as rules. The server keeps its six states (`queued → claimed → verified →
 * picked → billed → handed_over`); the desk shows five stages (PD-D1) and a pharmacist sees a
 * checklist, not a pipeline.
 */
export type DeskStage = "idle" | "found" | "working" | "payment" | "done";

/**
 * The ticket in hand decides the stage. `found` is a ticket that is not yet YOURS — still queued, or
 * cancelled under you — so the screen offers to take it rather than pretending it is being worked.
 */
export function stageOf(d: WireDispense | null, me: string | null = null): DeskStage {
  if (d === null) return "idle";
  /* PD-1 — somebody else's ticket, opened by its URL, is not being worked HERE. */
  if (heldByAnother(d, me)) return "found";
  switch (d.status) {
    case "claimed":
    case "verified":
      return "working";
    case "picked":
    case "billed":
      return "payment";
    case "handed_over":
      return "done";
    default:
      return "found";
  }
}

/** Held, and not by `me`. A handed-over or cancelled ticket is nobody's any more. */
export function heldByAnother(d: Pick<WireDispense, "status" | "claimedBy">, me: string | null): boolean {
  if (d.status === "handed_over" || d.status === "cancelled" || d.status === "queued") return false;
  return d.claimedBy !== null && d.claimedBy !== undefined && d.claimedBy !== me;
}

/** The four bars in the left rail. `found` and `idle` both sit on the first — nothing is collected yet. */
export const FLOW_STEPS = ["check", "collect", "money", "done"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];
export function flowIndex(stage: DeskStage): number {
  return stage === "done" ? 3 : stage === "payment" ? 2 : stage === "working" ? 1 : 0;
}

/**
 * PD-D8 — `P2609180048` renders as `P-48`: the series letter and the day's serial, the way the
 * front desk renders a token (`MED-4`). NULL before verify, which is when the server mints the
 * number today; the queue then names the ticket by its patient. Moving allocation earlier is an
 * owner ruling (PD-2) and this function does not pretend it has been made.
 */
export function ticketLabel(dispenseNo: string | null): string | null {
  if (dispenseNo === null) return null;
  const m = /^([A-Z]+)\d{6}(\d+)$/.exec(dispenseNo);
  return m === null ? dispenseNo : `${m[1]!}-${String(Number(m[2]!))}`;
}

/** Minutes a ticket has waited, as the rail prints it: `now`, `7m`, `1h 05m`. */
export function waitLabel(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Calm under six minutes, warm to a quarter hour, late after — the board's three colours. */
export type WaitTone = "calm" | "warm" | "late";
export function waitTone(fromIso: string, now: Date): WaitTone {
  const minutes = (now.getTime() - Date.parse(fromIso)) / 60_000;
  return minutes >= 15 ? "late" : minutes >= 6 ? "warm" : "calm";
}

/** A sealed patient is shown by the alias the hospital gave them, never by a name this reader may not see. */
export function whoLabel(p: WirePatientSummary): string {
  return p.alias ?? p.name ?? p.uhid;
}

export function initialsOf(p: WirePatientSummary): string {
  if (p.restricted || p.name === null) return "—";
  return p.name.split(/\s+/).filter((w) => w !== "").slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

/**
 * PD-D9 — a ticket on the list is one of three things to the reader: free to take, already theirs,
 * or somebody else's. The third is DIMMED and NAMED, never hidden: the owner wants the line seen
 * whole, and a pharmacist should learn "Vikas has this" from the list rather than from a refusal.
 */
export type Hold = { kind: "free" } | { kind: "mine" } | { kind: "theirs"; name: string };
export function holdOf(row: Pick<WireQueueRow, "status" | "claimedBy" | "claimedByName">, me: string | null): Hold {
  if (row.claimedBy === null || row.claimedBy === undefined) return { kind: "free" };
  if (row.claimedBy === me) return { kind: "mine" };
  return { kind: "theirs", name: row.claimedByName ?? "another pharmacist" };
}

/** `restricted` patients cannot be claimed by a reader without the grant (PD-1, E3); the row says so first. */
export function sealedFor(row: Pick<WireQueueRow, "patient">): boolean {
  return row.patient.restricted;
}
