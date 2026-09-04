import { describe, expect, it } from "vitest";
import { printSummary, PRINT_DOCUMENT_LABEL } from "./print-api";
import type { WirePrintJob } from "./print-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T5 — WHAT THE COUNTER IS TOLD ABOUT ITS OWN PAPER
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling R7: a print failure is ADVISORY. **Advisory is not silent**, and the difference is
 * this function. A hospital that learns about a jammed printer from the patient at the vitals desk
 * has a hidden failure wearing an advisory label.
 *
 * The wording is a pure function so it can be pinned without a browser, and because "what does the
 * clerk see when the prescription failed but the token printed" is a question worth answering in
 * one place rather than in JSX.
 */
function job(over: Partial<WirePrintJob>): WirePrintJob {
  return { id: "j1", document: "opd_token_slip", status: "queued", attempts: 0, lastError: null, printedAt: null, ...over };
}

describe("printSummary", () => {
  it("says nothing at all when nothing was queued — an empty rail, not an empty box", () => {
    expect(printSummary([])).toEqual({ state: "none", text: "", failed: [] });
  });

  it("counts what is still coming while the relay works", () => {
    const s = printSummary([job({ status: "printed" }), job({ id: "j2", document: "opd_prescription", status: "claimed" })]);
    expect(s.state).toBe("waiting");
    expect(s.text).toBe("Printing 1 of 2…");
    expect(s.failed).toEqual([]);
  });

  it("says both came out, which is what lets a clerk hand them over and move on", () => {
    const s = printSummary([job({ status: "printed" }), job({ id: "j2", document: "opd_prescription", status: "printed" })]);
    expect(s.state).toBe("printed");
    expect(s.text).toBe("Slip and sheet printed.");
  });

  /**
   * ═══ THE ONE THAT MATTERS ═══
   *
   * A failure OUTRANKS work still in progress. If the prescription has already failed, telling the
   * clerk "printing 1 of 2…" would keep them waiting for paper that is never coming — and they would
   * find out from the patient. The failure is named by DOCUMENT, because "something did not print"
   * sends a clerk to look at two printers.
   */
  it("a failure outranks anything still printing, and names the document", () => {
    const s = printSummary([
      job({ status: "queued" }),
      job({ id: "j2", document: "opd_prescription", status: "failed", attempts: 3, lastError: "out of paper" }),
    ]);
    expect(s.state).toBe("failed");
    expect(s.text).toBe("The prescription sheet did not print.");
    expect(s.failed.map((j) => j.id)).toEqual(["j2"]);
  });

  it("names both when both failed, so the clerk checks both printers", () => {
    const s = printSummary([
      job({ status: "failed" }),
      job({ id: "j2", document: "opd_prescription", status: "failed" }),
    ]);
    expect(s.text).toBe("The token slip and prescription sheet did not print.");
    expect(s.failed).toHaveLength(2); // …and each gets its own reprint button
  });

  it("every document the server can queue has a clerk-facing name — no wire keys on screen", () => {
    for (const key of ["opd_token_slip", "opd_prescription", "opd_payment_receipt", "vitals_slip"]) {
      expect(PRINT_DOCUMENT_LABEL[key]).toBeTruthy();
      expect(PRINT_DOCUMENT_LABEL[key]).not.toContain("_");
    }
  });
});
