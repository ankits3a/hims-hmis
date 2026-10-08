import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { NicknamesAdmin } from "./opd-nicknames";

/**
 * THE OWNER'S LIST OF LEARNED MEDICINE NICKNAMES (decisions 0051, 0055 — owner 2026-10-08).
 * Plain words, the catalogue's own names, one Undo a row; it opens with the pipeline off.
 */
const ROWS = [
  { id: "A1", nickname: "pan forty", medicine: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", detail: "40 mg · Gastro-resistant oral tablet", state: "suggested", removedBy: null, doctors: 2, taps: 4, changedAt: "2026-10-07T06:00:00.000Z" },
  { id: "A2", nickname: "dolo six fifty", medicine: "Dolo (paracetamol) 650 mg oral tablet", detail: "650 mg · Oral tablet", state: "trusted", removedBy: null, doctors: 5, taps: 31, changedAt: "2026-10-06T06:00:00.000Z" },
  { id: "A4", nickname: "razo twenty", medicine: "Razo (rabeprazole sodium) 20 mg gastro-resistant oral tablet", detail: "20 mg · Gastro-resistant oral tablet", state: "suggested", removedBy: null, doctors: 1, taps: 1, changedAt: "2026-10-05T06:00:00.000Z" },
  { id: "A5", nickname: "azee two fifty", medicine: "Azee (azithromycin) 250 mg oral tablet", detail: "250 mg · Oral tablet", state: "suggested", removedBy: null, doctors: 0, taps: 0, changedAt: "2026-10-05T06:00:00.000Z" },
  { id: "A3", nickname: "telma h", medicine: "Telma H (hydrochlorothiazide and telmisartan) 12.5 mg + 40 mg oral tablet", detail: "Oral tablet", state: "removed", removedBy: "doctors", doctors: 2, taps: 0, changedAt: "2026-10-05T06:00:00.000Z" },
];

describe("NicknamesAdmin", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("says the pipeline is OFF, lists each nickname with its full medicine name and state in plain words, and never says 'alias'", async () => {
    stubFetch({ "GET /api/opd/consult/nicknames": { on: false, counts: { suggested: 1, trusted: 1, removed: 1 }, items: ROWS } });
    renderWithProviders(<NicknamesAdmin />);

    expect(await screen.findByTestId("nicknames-switch")).toHaveTextContent("Nicknames are OFF on this server");
    expect(screen.getByTestId("nicknames-counts")).toHaveTextContent("1 suggested · 1 trusted · 1 removed");
    const a1 = screen.getByTestId("nickname-A1");
    expect(within(a1).getByTestId("nickname-term-A1")).toHaveTextContent("pan forty");
    expect(within(a1).getByTestId("nickname-medicine-A1")).toHaveTextContent("Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet");
    expect(a1).toHaveTextContent("40 mg · Gastro-resistant oral tablet");
    expect(a1).toHaveTextContent("2 doctors · used 4 times");
    expect(screen.getByTestId("nickname-A3")).toHaveTextContent("2 doctors · used 0 times");
    expect(screen.getByTestId("nickname-A4")).toHaveTextContent("1 doctor · used once");
    expect(screen.getByTestId("nickname-A5")).toHaveTextContent("Not used yet");
    expect(screen.getByTestId("nickname-state-A1")).toHaveTextContent("Suggested");
    expect(screen.getByTestId("nickname-state-A2")).toHaveTextContent("Trusted");
    expect(screen.getByTestId("nickname-state-A3")).toHaveTextContent("Removed — doctors crossed it off");
    expect(within(a1).getByRole("button", { name: "Undo" })).toBeEnabled();
    expect(within(screen.getByTestId("nickname-A3")).getByRole("button", { name: "Put back" })).toBeEnabled();
    expect(screen.getByTestId("nicknames-admin").textContent ?? "").not.toMatch(/alias/i);
  });

  it("Undo is one tap: it asks the server and re-reads the list; Show all asks for everything", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let undone = false;
    stubFetch({
      "GET /api/opd/consult/nicknames": (_i?: RequestInit, url?: string) => {
        calls.push(`GET ${url ?? ""}`);
        return { on: true, counts: { suggested: undone ? 0 : 1, trusted: 1, removed: undone ? 2 : 1 }, items: undone ? [{ ...ROWS[0], state: "removed", removedBy: "owner" }, ...ROWS.slice(1)] : ROWS };
      },
      "POST /api/opd/consult/nicknames/A1/undo": () => { calls.push("UNDO A1"); undone = true; return { ok: true }; },
    });
    renderWithProviders(<NicknamesAdmin />);
    expect(await screen.findByTestId("nicknames-switch")).toHaveTextContent("Nicknames are ON on this server");

    await user.click(within(screen.getByTestId("nickname-A1")).getByRole("button", { name: "Undo" }));
    expect(await within(screen.getByTestId("nickname-A1")).findByRole("button", { name: "Put back" })).toBeInTheDocument();
    expect(screen.getByTestId("nickname-state-A1")).toHaveTextContent("Removed");
    expect(screen.getByTestId("nicknames-counts")).toHaveTextContent("0 suggested · 1 trusted · 2 removed");
    expect(calls).toContain("UNDO A1");

    await user.click(screen.getByTestId("nicknames-all"));
    await screen.findByTestId("nickname-A2");
    expect(calls.some((c) => c.endsWith("/nicknames?all=1"))).toBe(true);
  });

  it("an empty week says so", async () => {
    stubFetch({ "GET /api/opd/consult/nicknames": { on: true, counts: { suggested: 0, trusted: 0, removed: 0 }, items: [] } });
    renderWithProviders(<NicknamesAdmin />);
    expect(await screen.findByTestId("nicknames-empty")).toHaveTextContent("Nothing was learned or changed in the last 7 days.");
  });
});
