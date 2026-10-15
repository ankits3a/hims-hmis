import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { setToken } from "../../lib/api";
import {
  DEFAULT_PRINT_SETTING, forgetAutoPrints, forgetPrintSetting, owedHere, printsHere, readPrintSetting, writePrintSetting,
} from "../../lib/browser-print";
import type { WirePrintJob } from "../../lib/print-api";
import { PrintHere } from "./print-here";
import { PapersSheet } from "./papers";
import { PrintingPanelHost, openPrintingPanel, usePrintSetting } from "../../components/printing-panel";

/**
 * BROWSER PRINTING (owner, 2026-10-07): *"When I click on handover, can't the browser automatically
 * send the print action for prescription slip to default printer? … I have to click on 'print the
 * paper again' and then from the popup, I have to click on 'save as pdf' and then print."*
 */

const job = (over: Partial<WirePrintJob> & Pick<WirePrintJob, "id" | "document">): WirePrintJob => ({
  status: "queued", attempts: 0, lastError: null, printedAt: null, createdAt: "2026-10-07T05:00:00.000Z", served: false, printedVia: null, ...over,
});
const RX = job({ id: "J-RX", document: "opd_prescription" });
const SLIP = job({ id: "J-SLIP", document: "opd_token_slip" });
const DOC = { html: "<!doctype html><html><head><title>Rx</title><style>@page{size:A4}</style></head><body><p id='rx'>PRESCRIPTION SHEET</p></body></html>", title: "Rx", page: { widthMm: 210, heightMm: 297 } };

/** jsdom has no printer: every frame this page makes gets a `print()` that counts and closes its "dialog". */
function hookFrames(closeDialog = true): { prints: () => number; bodies: () => string[]; restore: () => void } {
  let prints = 0;
  const bodies: string[] = [];
  const real = document.body.appendChild.bind(document.body);
  const spy = vi.spyOn(document.body, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    const out = real(node) as T;
    if (node instanceof HTMLIFrameElement && node.contentWindow !== null) {
      const w = node.contentWindow;
      w.print = (): void => {
        prints += 1;
        bodies.push(w.document.body.textContent ?? "");
        if (closeDialog) w.dispatchEvent(new Event("afterprint"));
      };
    }
    return out;
  });
  return { prints: () => prints, bodies: () => bodies, restore: () => spy.mockRestore() };
}

function calls(method: string, path: string): { url: string; init?: RequestInit }[] {
  const f = fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return f.mock.calls
    .filter(([u, init]) => (init?.method ?? "GET") === method && String(u).split("?")[0] === path)
    .map(([u, init]) => ({ url: String(u), init }));
}

function Harness({ jobs }: { jobs: WirePrintJob[] }): React.ReactElement {
  const setting = usePrintSetting();
  return printsHere(setting, jobs) ? <PrintHere jobs={jobs} setting={setting} onChanged={() => undefined} /> : <div data-testid="relay-road" />;
}

describe("browser printing — the counter's own printer, while no relay serves it", () => {
  let frames: ReturnType<typeof hookFrames>;
  beforeEach(() => {
    window.localStorage.clear();
    forgetPrintSetting();
    forgetAutoPrints();
    setToken("t");
    frames = hookFrames();
  });
  afterEach(() => { frames.restore(); vi.unstubAllGlobals(); });

  it("a browser nobody has told prints here only when the server says no relay serves the printer", () => {
    expect(readPrintSetting()).toEqual(DEFAULT_PRINT_SETTING);
    expect(printsHere(DEFAULT_PRINT_SETTING, [RX, SLIP])).toBe(true);
    expect(printsHere(DEFAULT_PRINT_SETTING, [{ ...RX, served: true }])).toBe(false);
    // An older server says nothing about relays: stay on the relay road rather than guess.
    expect(printsHere(DEFAULT_PRINT_SETTING, [{ ...RX, served: undefined }])).toBe(false);
    expect(printsHere(DEFAULT_PRINT_SETTING, [])).toBe(false);
    expect(printsHere({ ...DEFAULT_PRINT_SETTING, mode: "relay" }, [RX])).toBe(false);
    expect(printsHere({ ...DEFAULT_PRINT_SETTING, mode: "browser" }, [{ ...RX, served: true }])).toBe(true);
  });

  it("the sheet is owed and the token slip is not — the owner has no roll printer", () => {
    expect(owedHere(DEFAULT_PRINT_SETTING, [SLIP, RX]).map((j) => j.document)).toEqual(["opd_prescription"]);
    expect(owedHere(DEFAULT_PRINT_SETTING, [{ ...RX, status: "printed" }])).toEqual([]);
    const both = { ...DEFAULT_PRINT_SETTING, papers: { ...DEFAULT_PRINT_SETTING.papers, opd_token_slip: true } };
    expect(owedHere(both, [SLIP, RX]).map((j) => j.document)).toEqual(["opd_prescription", "opd_token_slip"]);
  });

  it("hand over prints the prescription sheet ONCE, from this page, and tells the server it reached paper here", async () => {
    stubFetch({
      "GET /api/print/jobs/J-RX/document": DOC,
      "POST /api/print/jobs/J-RX/printed-here": { accepted: true },
    });
    const open = vi.spyOn(window, "open");
    const { rerender } = renderWithProviders(<Harness jobs={[RX, SLIP]} />);

    expect(await screen.findByTestId("print-here-mode")).toHaveTextContent("Printing on this computer's printer.");
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    expect(frames.bodies()[0]).toContain("PRESCRIPTION SHEET"); // the server's own document, whole
    await waitFor(() => { expect(calls("POST", "/api/print/jobs/J-RX/printed-here")).toHaveLength(1); });
    expect(await screen.findByTestId("print-here-opd_prescription")).toHaveAttribute("data-state", "sent");

    // The token slip is switched off on this computer: never fetched, never printed, not listed.
    expect(calls("GET", "/api/print/jobs/J-SLIP/document")).toHaveLength(0);
    expect(screen.queryByTestId("print-here-opd_token_slip")).not.toBeInTheDocument();
    // No pop-up window anywhere on this road.
    expect(open).not.toHaveBeenCalled();

    // A poll that still says "queued", or a second look at the screen, prints nothing twice.
    rerender(<Harness jobs={[{ ...RX }, SLIP]} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(frames.prints()).toBe(1);
  });

  it("a print window that never reports back is NOT called printed — the button stays, and it says so", async () => {
    frames.restore();
    frames = hookFrames(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ "GET /api/print/jobs/J-RX/document": DOC, "POST /api/print/jobs/J-RX/printed-here": { accepted: true } });
    renderWithProviders(<Harness jobs={[RX]} />);
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
    vi.useRealTimers();
    const row = await screen.findByTestId("print-here-opd_prescription");
    expect(row).toHaveAttribute("data-state", "notYet");
    expect(row).toHaveTextContent("Prescription sheet not printed yet.");
    expect(screen.getByTestId("print-here-go-opd_prescription")).toHaveTextContent("Print the prescription sheet");
    expect(calls("POST", "/api/print/jobs/J-RX/printed-here")).toHaveLength(0);
  });

  it("a document that cannot be fetched is a plain sentence and a retry, not a claim of paper", async () => {
    let ok = false;
    stubFetch({
      "GET /api/print/jobs/J-RX/document": () => { if (!ok) throw new Error("network"); return DOC; },
      "POST /api/print/jobs/J-RX/printed-here": { accepted: true },
    });
    renderWithProviders(<Harness jobs={[RX]} />);
    const row = await screen.findByTestId("print-here-opd_prescription");
    await waitFor(() => { expect(row).toHaveAttribute("data-state", "failed"); });
    expect(frames.prints()).toBe(0);
    ok = true;
    await userEvent.click(screen.getByTestId("print-here-go-opd_prescription"));
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    await waitFor(() => { expect(row).toHaveAttribute("data-state", "sent"); });
  });

  it("where a relay serves the printer, nothing prints from this page", async () => {
    stubFetch({});
    renderWithProviders(<Harness jobs={[{ ...RX, served: true }, { ...SLIP, served: true }]} />);
    expect(await screen.findByTestId("relay-road")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(frames.prints()).toBe(0);
    expect((fetch as unknown as { mock: { calls: [unknown][] } }).mock.calls.filter(([u]) => String(u).includes("/api/print"))).toHaveLength(0);
  });

  it("their papers: Print prints here at once — a reprint is a new job, printed and marked, with no pop-up", async () => {
    const printed = { ...RX, status: "printed", printedVia: "browser" as const, printedAt: "2026-10-07T05:01:00.000Z" };
    stubFetch({
      "GET /api/print/jobs": { jobs: [printed] },
      "GET /api/billing/invoices": { invoices: [] },
      "POST /api/print/reprint": { id: "J-RX-2" },
      "GET /api/print/jobs/J-RX-2/document": DOC,
      "POST /api/print/jobs/J-RX-2/printed-here": { accepted: true },
    });
    const open = vi.spyOn(window, "open");
    renderWithProviders(<PapersSheet encounterId="enc-1" when={null} />);
    expect(await screen.findByTestId("papers-here")).toHaveTextContent("Printing on this computer's printer.");
    const btn = await screen.findByTestId("papers-reprint-opd_prescription");
    expect(btn).toHaveTextContent("print");
    expect(btn).not.toHaveTextContent("again");
    await userEvent.click(btn);
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    await waitFor(() => { expect(calls("POST", "/api/print/jobs/J-RX-2/printed-here")).toHaveLength(1); });
    expect(calls("POST", "/api/print/reprint")).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
    expect(await screen.findByTestId("papers-note")).toHaveTextContent("sent to this computer's printer");
    // Save as PDF is still there, second.
    expect(screen.getByTestId("papers-pdf-opd_prescription")).toBeInTheDocument();
  });

  it("their papers, with a relay serving: 'print again' still queues for the relay, exactly as before", async () => {
    stubFetch({
      "GET /api/print/jobs": { jobs: [{ ...RX, status: "printed", served: true, printedVia: "relay" }] },
      "GET /api/billing/invoices": { invoices: [] },
      "POST /api/print/reprint": { id: "J-RX-2" },
    });
    renderWithProviders(<PapersSheet encounterId="enc-1" when={null} />);
    const btn = await screen.findByTestId("papers-reprint-opd_prescription");
    expect(btn).toHaveTextContent("print again");
    expect(screen.queryByTestId("papers-here")).not.toBeInTheDocument();
    await userEvent.click(btn);
    await waitFor(() => { expect(calls("POST", "/api/print/reprint")).toHaveLength(1); });
    expect(frames.prints()).toBe(0);
    expect(await screen.findByTestId("papers-note")).toHaveTextContent("queued again");
  });

  it("the panel: the choice is this computer's, the slip is off until switched on, and a test page prints", async () => {
    stubFetch({});
    renderWithProviders(<PrintingPanelHost />);
    act(() => { openPrintingPanel(); });
    const panel = await screen.findByTestId("printing-panel");
    expect(panel).toHaveTextContent("Printing on this computer");
    expect(screen.getByTestId("print-mode-auto")).toBeChecked();
    expect(screen.getByTestId("print-paper-opd_prescription")).toBeChecked();
    expect(screen.getByTestId("print-paper-opd_token_slip")).not.toBeChecked();

    await userEvent.click(screen.getByTestId("print-paper-opd_token_slip"));
    expect(screen.getByTestId("print-two-dialogs")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("print-mode-relay"));
    forgetPrintSetting();
    expect(readPrintSetting()).toMatchObject({ mode: "relay", papers: { opd_prescription: true, opd_token_slip: true } });

    writePrintSetting(DEFAULT_PRINT_SETTING);
    await userEvent.click(screen.getByTestId("print-test"));
    await waitFor(() => { expect(frames.prints()).toBe(1); });
    expect(await screen.findByTestId("print-test-result")).toHaveTextContent("Sent to the printer");

    await userEvent.click(screen.getByTestId("print-help-toggle"));
    expect(screen.getByTestId("print-help")).toHaveTextContent("--kiosk-printing");
    await userEvent.click(screen.getByTestId("printing-close"));
    expect(screen.queryByTestId("printing-panel")).not.toBeInTheDocument();
  });
});
