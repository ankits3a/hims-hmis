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
  /** FD-25 — so a reprint can be told from the row it replaces without trusting the route's order. */
  createdAt: string;
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

/**
 * ═══ FD-28 — THE SAME DOCUMENT, ON A SCREEN, SO IT CAN BE SAVED AS A PDF ═══
 *
 * Owner, 2026-09-06: *"enable and add the feature of browser based printing as a 'Save as pdf' as
 * direct printing isn't available because the machine isn't available."*
 *
 * `GET /print/jobs/:id/document` returns exactly what `POST /print/claim` hands the relay — the same
 * `renderDocument` output, from the same template. So the PDF a clerk saves today and the paper that
 * comes off the thermal head once the relay is installed are ONE document, not two implementations
 * drifting apart. It carries the reprint route's own permission and its §14 gate, because producing
 * a patient's prescription on a monitor is the same disclosure as producing it on paper.
 */
export type WireRenderedDocument = {
  html: string;
  title: string;
  page: { widthMm: number; heightMm: number | null };
};

export function fetchPrintDocument(jobId: string): Promise<WireRenderedDocument | null> {
  return api("GET", `/print/jobs/${encodeURIComponent(jobId)}/document`);
}

/**
 * Open a rendered document in its own window and raise the print dialog, where the browser's own
 * "Save as PDF" destination lives.
 *
 * ═══ A SEPARATE WINDOW, NOT THIS ONE ═══
 *
 * `styles.css`'s `.print-doc` isolation prints exactly one element of the CURRENT page and hides
 * everything else — which is right for a React document rendered inside a screen, and wrong here
 * twice over: the server's HTML is a whole document with its own `@page` size (72 mm continuous for
 * a slip, A4 for a prescription sheet), and injecting it into this page would fight both the app's
 * stylesheet and any `.print-doc` already mounted. A fresh window has no stylesheet of ours in it,
 * so the document prints as the printer would render it.
 *
 * Returns false when the browser refused the window — a pop-up blocker is the ordinary cause and the
 * caller must say so rather than leaving a button that silently does nothing.
 */
export function openDocumentForPrinting(doc: WireRenderedDocument): boolean {
  const w = window.open("", "_blank", "width=820,height=900");
  if (w === null) return false;
  w.document.write(doc.html);
  w.document.close();
  /*
    `onload` before `print()`: a thermal slip is one page of inline CSS and prints fine either way,
    but the A4 prescription sheet carries a letterhead and calling `print()` against a document the
    browser has not finished laying out is how a half-drawn page reaches paper.
  */
  w.onload = () => { w.focus(); w.print(); };
  return true;
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

  /*
    ═══ FD-25 — THE RAIL COULD NOT RECOVER, INCLUDING FROM A SUCCESSFUL REPRINT ═══

    This read `jobs.filter(status === "failed")` over EVERY job for the encounter and short-circuited
    on any hit. `reportFailed` at MAX_ATTEMPTS is terminal and a reprint mints a NEW row, so once a
    token slip failed the desk read "The token slip did not print." for the rest of the encounter —
    and went on reading it after a reprint came out of the printer. The one action the message
    offered could not clear the message.

    It also said "The token slip and token slip did not print." once a failed reprint existed,
    because the names were joined per JOB rather than per DOCUMENT.

    A DOCUMENT HAS ONE CURRENT STATE and it is the newest row's. Grouping by document and taking the
    latest `createdAt` is the whole fix: two rows for one slip are two ATTEMPTS at one thing, not
    two things.
  */
  const latestPerDocument = new Map<string, WirePrintJob>();
  for (const job of jobs) {
    const held = latestPerDocument.get(job.document);
    if (held === undefined || job.createdAt > held.createdAt) latestPerDocument.set(job.document, job);
  }
  const current = [...latestPerDocument.values()];

  const failed = current.filter((j) => j.status === "failed");
  if (failed.length > 0) {
    /* De-duplicated by construction now: one entry per document, so one name per document. */
    const names = failed.map((j) => PRINT_DOCUMENT_LABEL[j.document] ?? j.document).join(" and ");
    return { state: "failed", text: `The ${names} did not print.`, failed };
  }
  const pending = current.filter((j) => j.status === "queued" || j.status === "claimed");
  if (pending.length > 0) {
    return { state: "waiting", text: `Printing ${String(pending.length)} of ${String(current.length)}…`, failed: [] };
  }
  return { state: "printed", text: "Slip and sheet printed.", failed: [] };
}
