import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { setToken } from "../../lib/api";
import { DEFAULT_PRINT_SETTING, forgetAutoPrints, forgetPrintSetting, printsHere, readPrintSetting, writePrintSetting } from "../../lib/browser-print";
import type { WirePrintJob } from "../../lib/print-api";
import { PrintHere } from "./print-here";
import { PrintingPanelHost, openPrintingPanel, usePrintSetting } from "../../components/printing-panel";

/**
 * Decision 0047 — THIS COMPUTER'S OWN PRINT PROGRAM, as the desk meets it.
 *
 * What the screen decides, and so what is pinned: a paper owed here goes to the linked program and
 * NOT to a print window; the moment the program refuses (switched off, removed, an older server)
 * the window prints exactly as decision 0045 says; a person who chose "this computer's own printer"
 * is never overruled; and a paper the program was given and did not put out is offered to the
 * window after a wait, never silently left.
 */
const job = (over: Partial<WirePrintJob> & Pick<WirePrintJob, "id" | "document">): WirePrintJob => ({
  status: "queued", attempts: 0, lastError: null, printedAt: null, createdAt: "2026-10-07T05:00:00.000Z", served: false, printedVia: null, ...over,
});
const RX = job({ id: "J-RX", document: "opd_prescription" });
const SLIP = job({ id: "J-SLIP", document: "opd_token_slip" });
const DOC = { html: "<!doctype html><html><head><title>Rx</title></head><body><p>PRESCRIPTION SHEET</p></body></html>", title: "Rx", page: { widthMm: 210, heightMm: 297 } };

function hookFrames(): { prints: () => number; restore: () => void } {
  let prints = 0;
  const real = document.body.appendChild.bind(document.body);
  const spy = vi.spyOn(document.body, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    const out = real(node) as T;
    if (node instanceof HTMLIFrameElement && node.contentWindow !== null) {
      const w = node.contentWindow;
      w.print = (): void => { prints += 1; w.dispatchEvent(new Event("afterprint")); };
    }
    return out;
  });
  return { prints: () => prints, restore: () => spy.mockRestore() };
}
function calls(method: string, path: string): { body: unknown }[] {
  const f = fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return f.mock.calls
    .filter(([u, init]) => (init?.method ?? "GET") === method && String(u).split("?")[0] === path)
    .map(([, init]) => ({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }));
}
function Harness({ jobs, onChanged = () => undefined }: { jobs: WirePrintJob[]; onChanged?: () => void }): React.ReactElement {
  const setting = usePrintSetting();
  return printsHere(setting, jobs) ? <PrintHere jobs={jobs} setting={setting} onChanged={onChanged} /> : <div data-testid="relay-road" />;
}

describe("decision 0047 — this computer's own print program", () => {
  let frames: ReturnType<typeof hookFrames>;
  beforeEach(() => {
    window.localStorage.clear();
    forgetPrintSetting();
    forgetAutoPrints();
    setToken("t");
    frames = hookFrames();
  });
  afterEach(() => { frames.restore(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("a computer nobody linked has no program, and an old saved setting reads as none", () => {
    expect(DEFAULT_PRINT_SETTING.computerId).toBeNull();
    window.localStorage.setItem("hmis.print.thisComputer.v1", JSON.stringify({ mode: "auto", papers: { opd_prescription: true } }));
    forgetPrintSetting();
    expect(readPrintSetting().computerId).toBeNull();
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "PC1" });
    forgetPrintSetting();
    expect(readPrintSetting().computerId).toBe("PC1");
  });

  it("hand over sends the sheet to the linked program — no print window, no 'printed here' — and says printed when the program reports", async () => {
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "PC1" });
    stubFetch({ "POST /api/print/jobs/J-RX/send-to-computer": { sent: true, reason: null } });
    const { rerender } = renderWithProviders(<Harness jobs={[RX, SLIP]} />);

    expect(await screen.findByTestId("print-here-mode")).toHaveTextContent("Printing through this computer's print program.");
    await waitFor(() => { expect(calls("POST", "/api/print/jobs/J-RX/send-to-computer")).toEqual([{ body: { computerId: "PC1" } }]); });
    const row = await screen.findByTestId("print-here-opd_prescription");
    await waitFor(() => { expect(row).toHaveAttribute("data-state", "program"); });
    expect(row).toHaveTextContent("Prescription sheet sent to this computer's print program…");
    expect(screen.queryByTestId("print-here-go-opd_prescription")).not.toBeInTheDocument();
    expect(frames.prints()).toBe(0);
    expect(calls("GET", "/api/print/jobs/J-RX/document")).toHaveLength(0);
    expect(calls("POST", "/api/print/jobs/J-RX/printed-here")).toHaveLength(0);

    // The program printed and told the server; the next read of the jobs says so.
    rerender(<Harness jobs={[{ ...RX, status: "printed", printedVia: "relay" }, SLIP]} />);
    await waitFor(() => { expect(screen.getByTestId("print-here-opd_prescription")).toHaveAttribute("data-state", "sent"); });
    expect(frames.prints()).toBe(0);
  });

  it("a program that is switched off is not waited for: the window prints, exactly as before", async () => {
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "PC1" });
    stubFetch({
      "POST /api/print/jobs/J-RX/send-to-computer": { sent: false, reason: "offline" },
      "GET /api/print/jobs/J-RX/document": DOC,
      "POST /api/print/jobs/J-RX/printed-here": { accepted: true },
    });
    renderWithProviders(<Harness jobs={[RX]} />);
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    await waitFor(() => { expect(calls("POST", "/api/print/jobs/J-RX/printed-here")).toHaveLength(1); });
    expect(await screen.findByTestId("print-here-opd_prescription")).toHaveAttribute("data-state", "sent");
  });

  it("an older server with no such route is the same as a program that is off", async () => {
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "PC1" });
    stubFetch({ "GET /api/print/jobs/J-RX/document": DOC, "POST /api/print/jobs/J-RX/printed-here": { accepted: true } });
    renderWithProviders(<Harness jobs={[RX]} />);
    await waitFor(() => { expect(frames.prints()).toBe(1); });
  });

  it("a person who chose 'this computer's own printer' is never sent to the program", async () => {
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, mode: "browser", computerId: "PC1" });
    stubFetch({
      "POST /api/print/jobs/J-RX/send-to-computer": { sent: true, reason: null },
      "GET /api/print/jobs/J-RX/document": DOC,
      "POST /api/print/jobs/J-RX/printed-here": { accepted: true },
    });
    renderWithProviders(<Harness jobs={[RX]} />);
    expect(await screen.findByTestId("print-here-mode")).toHaveTextContent("Printing on this computer's printer.");
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    expect(calls("POST", "/api/print/jobs/J-RX/send-to-computer")).toHaveLength(0);
  });

  it("a roll slip is never handed to an A4 program — it takes the window even when a program is linked", async () => {
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "PC1", papers: { opd_prescription: false, opd_token_slip: true, opd_payment_receipt: false } });
    stubFetch({ "GET /api/print/jobs/J-SLIP/document": DOC, "POST /api/print/jobs/J-SLIP/printed-here": { accepted: true } });
    renderWithProviders(<Harness jobs={[RX, SLIP]} />);
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    expect(calls("POST", "/api/print/jobs/J-SLIP/send-to-computer")).toHaveLength(0);
  });

  it("a sheet the program was given and did not put out is offered to the window after the wait — and asked about meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "PC1" });
    stubFetch({
      "POST /api/print/jobs/J-RX/send-to-computer": { sent: true, reason: null },
      "GET /api/print/jobs/J-RX/document": DOC,
      "POST /api/print/jobs/J-RX/printed-here": { accepted: false },
    });
    const asked = vi.fn();
    renderWithProviders(<Harness jobs={[RX]} onChanged={asked} />);
    await waitFor(() => { expect(screen.getByTestId("print-here-opd_prescription")).toHaveAttribute("data-state", "program"); });
    const before = asked.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(asked.mock.calls.length).toBeGreaterThan(before); // the screen keeps asking the server

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    const row = screen.getByTestId("print-here-opd_prescription");
    expect(row).toHaveTextContent("Prescription sheet has not come out of the print program yet.");
    const go = screen.getByTestId("print-here-go-opd_prescription");
    expect(go).toHaveTextContent("Print the prescription sheet from this window");
    vi.useRealTimers();
    await userEvent.click(go);
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    // It went to the WINDOW this time, not back to the program that did not deliver.
    expect(calls("POST", "/api/print/jobs/J-RX/send-to-computer")).toHaveLength(1);
  });

  it("the panel: choose this computer's program once; it says running or not, and 'none' unlinks", async () => {
    stubFetch({ "GET /api/print/computers/here": { computers: [
      { id: "PC1", name: "Front desk 1", printer: "HP LaserJet M1005", alive: true },
      { id: "PC2", name: "Front desk 2", printer: null, alive: false },
    ] } });
    renderWithProviders(<PrintingPanelHost />);
    act(() => { openPrintingPanel(); });
    const select = await screen.findByTestId("print-program-select");
    expect(select).toHaveValue("");
    expect(screen.queryByTestId("print-program-state")).not.toBeInTheDocument();

    await userEvent.selectOptions(select, "PC1");
    expect(await screen.findByTestId("print-program-state")).toHaveTextContent("Front desk 1 is running — papers go to HP LaserJet M1005.");
    forgetPrintSetting();
    expect(readPrintSetting().computerId).toBe("PC1");

    await userEvent.selectOptions(screen.getByTestId("print-program-select"), "PC2");
    expect(screen.getByTestId("print-program-state")).toHaveTextContent("Front desk 2 is not running, so this window prints.");

    await userEvent.selectOptions(screen.getByTestId("print-program-select"), "");
    expect(screen.queryByTestId("print-program-state")).not.toBeInTheDocument();
    forgetPrintSetting();
    expect(readPrintSetting().computerId).toBeNull();
  });

  it("the panel: a linked program that was removed says so; a seat that may not read the list is shown no program section, and the rest still works", async () => {
    writePrintSetting({ ...DEFAULT_PRINT_SETTING, computerId: "GONE" });
    stubFetch({ "GET /api/print/computers/here": { computers: [] } });
    const first = renderWithProviders(<PrintingPanelHost />);
    act(() => { openPrintingPanel(); });
    expect(await screen.findByTestId("print-program-state")).toHaveTextContent("has been removed. Choose again.");
    first.unmount();

    writePrintSetting(DEFAULT_PRINT_SETTING);
    stubFetch({});
    renderWithProviders(<PrintingPanelHost />);
    act(() => { openPrintingPanel(); });
    expect(await screen.findByTestId("print-mode-auto")).toBeChecked();
    await waitFor(() => { expect(screen.queryByTestId("print-program")).not.toBeInTheDocument(); });
  });
});
