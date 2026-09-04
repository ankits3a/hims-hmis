import { api } from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T5 — WHAT THE COUNTER KNOWS ABOUT ITS OWN PAPER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling R7: a print failure is ADVISORY — nothing in the money or queue path waits on a
 * printer, and a patient can be sent to the doctor on a spoken token.
 *
 * **Advisory is not the same as silent, and that distinction is this file's whole job.** If the slip
 * did not come out, the clerk has to know WHILE THE PATIENT IS STILL STANDING THERE. A hospital that
 * learns about a jammed printer from the patient at the vitals desk has an advisory failure that
 * behaves exactly like a hidden one.
 *
 * The desk does not enqueue anything: opening the visit already did that, inside the visit's own
 * transaction (`joinSessionInTx`). So there is no "print" button — a token and its paper are one
 * event. What the screen offers is the truth about that paper, and a reprint when it is bad news.
 */

export type WirePrintJob = {
  id: string;
  document: string;
  /** 'queued' | 'claimed' | 'printed' | 'failed' | 'cancelled' */
  status: string;
  attempts: number;
  lastError: string | null;
  printedAt: string | null;
};

/** Every job queued for one visit, newest first. Scoped to the patient in hand, never a queue browser. */
export function listPrintJobs(encounterId: string): Promise<{ jobs: WirePrintJob[] }> {
  return api("GET", `/print/jobs?encounterId=${encodeURIComponent(encounterId)}`);
}

/**
 * Ask for the same document again.
 *
 * A reprint is a NEW job, never a revived one — the server mints a fresh dedupe key and records a
 * fresh requester, so both attempts survive and "who printed this again" stays answerable about a
 * document carrying a patient's name.
 */
export function reprintJob(jobId: string): Promise<{ id: string | null }> {
  return api("POST", "/print/reprint", { jobId });
}

/** The clerk-facing name of each document. The wire keys are the server's; these are the counter's. */
export const PRINT_DOCUMENT_LABEL: Record<string, string> = {
  opd_token_slip: "token slip",
  opd_prescription: "prescription sheet",
  opd_payment_receipt: "payment receipt",
  vitals_slip: "vitals slip",
};

/**
 * What the rail should SAY about a set of jobs, as one line.
 *
 * A pure function so the wording is testable without a browser, and so the three states a clerk
 * actually acts on are named in one place:
 *
 *   · `waiting` — queued or claimed. The relay has it or is about to. Nothing to do.
 *   · `printed` — all of it came out. Hand it over.
 *   · `failed`  — at least one document did not. THIS is the one that must be visible, and it is
 *     the only state that offers an action.
 */
export function printSummary(jobs: WirePrintJob[]): {
  state: "none" | "waiting" | "printed" | "failed";
  text: string;
  failed: WirePrintJob[];
} {
  if (jobs.length === 0) return { state: "none", text: "", failed: [] };
  const failed = jobs.filter((j) => j.status === "failed");
  if (failed.length > 0) {
    const names = failed.map((j) => PRINT_DOCUMENT_LABEL[j.document] ?? j.document).join(" and ");
    return { state: "failed", text: `The ${names} did not print.`, failed };
  }
  const pending = jobs.filter((j) => j.status === "queued" || j.status === "claimed");
  if (pending.length > 0) {
    return { state: "waiting", text: `Printing ${String(pending.length)} of ${String(jobs.length)}…`, failed: [] };
  }
  return { state: "printed", text: "Slip and sheet printed.", failed: [] };
}
