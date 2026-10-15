import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LearnedAboutMe, type WireLearned } from "./learned-about-me";
import { api } from "../lib/api";
import { renderWithProviders } from "../test-utils";

/*
 * Decision 0050 P4 (#615): the doctor sees what the suggestions learned from them and can reset it.
 * A reset never fires without a confirm, names only the surface asked for, and the panel shows no money.
 */
vi.mock("../lib/api", () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);

const learned = (over: Partial<WireLearned> = {}): WireLearned => ({
  since: { complaints: null, diagnoses: null, tests: "2026-10-01T00:00:00.000Z", findings: null, hidden: null },
  complaints: [{ term: "fever", uses: 4 }],
  diagnoses: [{ text: "Viral fever", icd10Code: "B34.9", uses: 3 }],
  tests: [{ diagnosis: "b34.9", name: "CBC", uses: 2 }],
  findings: [],
  hidden: [{ kind: "test", contextKey: "b34.9", itemKey: "svc-1" }, { kind: "test", contextKey: null, itemKey: "svc-2" }],
  ...over,
});

beforeEach(() => { apiMock.mockReset(); });

describe("LearnedAboutMe", () => {
  it("lists the doctor's own patterns per surface, with no money on the panel", async () => {
    apiMock.mockResolvedValueOnce(learned());
    renderWithProviders(<LearnedAboutMe open onClose={() => undefined} />);
    expect(await screen.findByText(/fever · 4 times/)).toBeInTheDocument();
    expect(screen.getByText(/Viral fever · B34.9 · 3 times/)).toBeInTheDocument();
    expect(screen.getByText(/CBC for b34.9 · 2 times/)).toBeInTheDocument();
    expect(screen.getByTestId("learned-findings-empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("learned-hidden")).getByText("2 test hidden")).toBeInTheDocument();
    expect(within(screen.getByTestId("learned-tests")).getByText(/Since your reset on/)).toBeInTheDocument();
    expect(screen.getByTestId("learned-reset-findings")).toBeDisabled();
    expect(apiMock).toHaveBeenCalledWith("GET", "/opd/consult/learned");
    const text = screen.getByTestId("learned-about-me").textContent ?? "";
    expect(text).not.toMatch(/₹|paise|price|paid/i);
  });

  it("asks before a reset, and Keep sends nothing", async () => {
    apiMock.mockResolvedValueOnce(learned());
    renderWithProviders(<LearnedAboutMe open onClose={() => undefined} />);
    await userEvent.click(await screen.findByTestId("learned-reset-complaints"));
    expect(screen.getByTestId("learned-confirm")).toHaveTextContent("Reset your Complaints?");
    await userEvent.click(screen.getByTestId("learned-confirm-no"));
    expect(screen.queryByTestId("learned-confirm")).toBeNull();
    expect(apiMock.mock.calls.filter((c) => c[0] === "POST")).toHaveLength(0);
  });

  it("resets only the surface confirmed, then reads again", async () => {
    apiMock.mockResolvedValueOnce(learned());
    apiMock.mockResolvedValueOnce({ resetAt: "2026-10-15T00:00:00.000Z", surfaces: ["complaints"] });
    apiMock.mockResolvedValueOnce(learned({ complaints: [], since: { ...learned().since, complaints: "2026-10-15T00:00:00.000Z" } }));
    renderWithProviders(<LearnedAboutMe open onClose={() => undefined} />);
    await userEvent.click(await screen.findByTestId("learned-reset-complaints"));
    await userEvent.click(screen.getByTestId("learned-confirm-yes"));
    expect(apiMock).toHaveBeenCalledWith("POST", "/opd/consult/learned/reset", { surfaces: ["complaints"] });
    expect(await screen.findByTestId("learned-complaints-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("learned-confirm")).toBeNull();
  });

  it("Reset all sends 'all' after the confirm", async () => {
    apiMock.mockResolvedValueOnce(learned());
    apiMock.mockResolvedValueOnce({ resetAt: "2026-10-15T00:00:00.000Z", surfaces: ["complaints", "diagnoses", "tests", "findings", "hidden"] });
    apiMock.mockResolvedValue(learned());
    renderWithProviders(<LearnedAboutMe open onClose={() => undefined} />);
    await userEvent.click(await screen.findByTestId("learned-reset-all"));
    expect(screen.getByTestId("learned-confirm")).toHaveTextContent("Reset everything learned from you?");
    await userEvent.click(screen.getByTestId("learned-confirm-yes"));
    await waitFor(() => { expect(apiMock).toHaveBeenCalledWith("POST", "/opd/consult/learned/reset", { surfaces: "all" }); });
  });
});
