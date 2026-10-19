import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import en from "../locales/en.json";
import hi from "../locales/hi.json";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { EsiCopilotCard } from "./er-copilot";
import type { ErEsiProposal, ErEsiProposalCheck, ErProposalWithdrawReason } from "@hmis/contracts";

/**
 * #899 (spec §6 edge 1) — a triage suggestion left open on a screen asks whether it still stands; when the record has moved
 * on it withdraws itself with the reason and loses its "Use" button. A failed check withdraws it too (fail closed).
 * Server stubbed.
 */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const EP = "01J00000000000000000000P09";
const PROPOSAL: ErEsiProposal = {
  episodeId: EP, level: 2, word: "ESI 2 Emergent", decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false },
  reasons: ['Complaint: "chest pain" (high risk)'], resourcesGuessed: false,
  basedOn: { complaint: "chest pain", ageYears: 52, vitalsAt: null }, source: "rules", basis: "v1.-.-.0123456789abcdef",
};
/** The web imports contracts for types only: a Record over the union makes tsc name a reason added without words. */
const REASONS: Record<ErProposalWithdrawReason, true> = {
  triaged: true, re_triaged: true, moved: true, departed: true, new_vitals: true, details_changed: true, out_of_date: true,
};
const AT = "2026-10-19T08:35:00.000Z"; // 14:05 IST
const CURRENT: ErEsiProposalCheck = { episodeId: EP, current: true, withdrawn: null };
const VITALS: ErEsiProposalCheck = {
  episodeId: EP, current: false,
  withdrawn: { reason: "new_vitals", at: AT, level: null, bayCode: null, text: "New vitals at 14:05", fresh: true },
};

describe("#899 the triage suggestion withdraws itself", () => {
  let reply: () => Response;
  const checks: string[] = [];
  beforeEach(() => {
    setToken("t");
    checks.length = 0;
    reply = () => json(CURRENT);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (raw.includes("/check?")) { checks.push(raw); return reply(); }
      if (raw.includes("/er/copilot/esi/")) return json(PROPOSAL);
      return json([]);
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const tick = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); };

  it("a proposal that still stands keeps its Use button; the check sends the proposal's basis", async () => {
    renderWithRouter(<EsiCopilotCard episodeId={EP} onUse={() => undefined} />);
    await screen.findByTestId("er-triage-copilot-use");
    await tick();
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]).toContain(`basis=${encodeURIComponent(PROPOSAL.basis)}`);
    expect(screen.getByTestId("er-triage-copilot-use")).toBeInTheDocument();
  });

  it("new vitals: withdrawn with the reason and time, no Use; 'Show new suggestion' brings the current one", async () => {
    renderWithRouter(<EsiCopilotCard episodeId={EP} onUse={() => undefined} />);
    await screen.findByTestId("er-triage-copilot-use");
    reply = () => json(VITALS);
    await tick();
    expect(await screen.findByTestId("er-triage-copilot-why")).toHaveTextContent("New vitals at 14:05");
    expect(screen.getByTestId("er-triage-copilot")).toHaveTextContent("Suggestion withdrawn");
    expect(screen.queryByTestId("er-triage-copilot-use")).toBeNull();
    reply = () => json(CURRENT);
    await userEvent.click(screen.getByTestId("er-triage-copilot-fresh"));
    expect(await screen.findByTestId("er-triage-copilot-use")).toBeInTheDocument();
  });

  it("a person triaged: withdrawn for good (no new suggestion offered)", async () => {
    renderWithRouter(<EsiCopilotCard episodeId={EP} onUse={() => undefined} />);
    await screen.findByTestId("er-triage-copilot-use");
    reply = () => json({ episodeId: EP, current: false, withdrawn: { reason: "triaged", at: AT, level: 1, bayCode: null, text: "Triaged ESI 1 at 14:05", fresh: false } });
    await tick();
    expect(await screen.findByTestId("er-triage-copilot-why")).toHaveTextContent("Triaged ESI 1 at 14:05");
    expect(screen.queryByTestId("er-triage-copilot-fresh")).toBeNull();
    expect(screen.queryByTestId("er-triage-copilot-use")).toBeNull();
  });

  it("fails closed: a check that fails withdraws the card as out of date", async () => {
    renderWithRouter(<EsiCopilotCard episodeId={EP} onUse={() => undefined} />);
    await screen.findByTestId("er-triage-copilot-use");
    reply = () => json({ statusCode: 500 }, 500);
    await tick();
    expect(await screen.findByTestId("er-triage-copilot-why")).toHaveTextContent("Suggestion out of date");
    expect(screen.queryByTestId("er-triage-copilot-use")).toBeNull();
  });

  it("every withdrawal reason has its words in English and Hindi", () => {
    const why = (l: unknown) => (l as { erCopilot: { esi: { why: Record<string, string> } } }).erCopilot.esi.why;
    for (const r of Object.keys(REASONS)) {
      expect(why(en)[r]).toBeTruthy();
      expect(why(hi)[r]).toBeTruthy();
    }
  });
});
