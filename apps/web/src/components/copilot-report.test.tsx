import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopilotReport } from "./copilot-report";
import * as api from "../lib/api";
import type { CopilotDayReport } from "../lib/copilot-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-COPILOT — "IT SHOULD DO IT AND GIVE IT TO THE USER"
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's second example, and the word that does the work is GIVE. Before this component the
 * copilot answered *about* a report — the server had composed the sections, the hook was holding
 * them, and the bar had nowhere to put them. An answer about a report is not a report, and these
 * tests are written against that specific failure.
 */
const report = (over: Partial<CopilotDayReport> = {}): CopilotDayReport => ({
  date: "2026-09-17",
  provisional: false,
  sections: [{
    key: "opd.myVisits",
    titleKey: "Visits I opened",
    columnKeys: ["Time", "Visit", "Patient"],
    rows: [["09:12", "V2609170001", "Asha Devi"], ["09:40", "V2609170002", "Ramesh Kumar"]],
  }],
  ...over,
});

describe("CopilotReport", () => {
  it("renders the rows themselves, not a sentence about them", () => {
    render(<CopilotReport report={report()} onDismiss={() => undefined} />);
    expect(screen.getByText("V2609170001")).toBeInTheDocument();
    expect(screen.getByText("Asha Devi")).toBeInTheDocument();
    expect(screen.getByText("Ramesh Kumar")).toBeInTheDocument();
  });

  it("renders the column headings the server named", () => {
    render(<CopilotReport report={report()} onDismiss={() => undefined} />);
    expect(screen.getByText("Patient")).toBeInTheDocument();
  });

  it("renders a totals row when the section has one", () => {
    const withTotals = report({
      sections: [{
        key: "billing.collected", titleKey: "Collected", columnKeys: ["Mode", "Amount"],
        rows: [["Cash", "₹4,200"]], totals: ["Total", "₹4,200"],
      }],
    });
    render(<CopilotReport report={withTotals} onDismiss={() => undefined} />);
    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("says so rather than rendering an empty table when a section has no rows", () => {
    const empty = report({
      sections: [{ key: "k", titleKey: "Nothing yet", columnKeys: ["Time"], rows: [] }],
    });
    render(<CopilotReport report={empty} onDismiss={() => undefined} />);
    expect(screen.getByText("copilot.report.emptySection")).toBeInTheDocument();
  });

  /**
   * PROVISIONAL IS THE SERVER'S FLAG, carried through rather than re-derived. A clerk who files a
   * provisional report as final has been misled by the screen, not by the data — so the stamp is
   * present exactly when the server says the day has not closed, and absent otherwise.
   */
  it("stamps a provisional day", () => {
    render(<CopilotReport report={report({ provisional: true })} onDismiss={() => undefined} />);
    expect(screen.getByTestId("copilot-report-provisional")).toBeInTheDocument();
  });

  it("does not stamp a closed day", () => {
    render(<CopilotReport report={report({ provisional: false })} onDismiss={() => undefined} />);
    expect(screen.queryByTestId("copilot-report-provisional")).not.toBeInTheDocument();
  });

  /**
   * ═══ THE DOWNLOAD GOES THROUGH THE ROUTE THAT AUDITS ITSELF ═══
   *
   * `GET /me/report.csv` appends a `report.exported` event BEFORE returning bytes. Serialising
   * these rows in the browser would produce the same file and no event — a file leaving the
   * building with nobody's name on it. So the assertion is about WHICH route is called, not about
   * whether a file appears.
   */
  it("exports through /me/report.csv for the report's own date", async () => {
    const calls: string[] = [];
    const spy = vi.spyOn(api, "apiDownload").mockImplementation((path: string) => {
      calls.push(path);
      return Promise.resolve();
    });
    render(<CopilotReport report={report()} onDismiss={() => undefined} />);
    await userEvent.click(screen.getByTestId("copilot-report-csv"));
    expect(calls).toEqual(["/me/report.csv?date=2026-09-17"]);
    spy.mockRestore();
  });

  it("says the download failed rather than looking like it worked", async () => {
    const spy = vi.spyOn(api, "apiDownload").mockRejectedValue(new Error("network"));
    render(<CopilotReport report={report()} onDismiss={() => undefined} />);
    await userEvent.click(screen.getByTestId("copilot-report-csv"));
    expect(await screen.findByText("copilot.report.downloadFailed")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("can be dismissed", async () => {
    let dismissed = false;
    render(<CopilotReport report={report()} onDismiss={() => { dismissed = true; }} />);
    await userEvent.click(screen.getByTestId("copilot-report-dismiss"));
    expect(dismissed).toBe(true);
  });
});
