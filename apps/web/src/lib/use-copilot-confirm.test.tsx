import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "./api";
import { resetCopilotNoticeForTests } from "./copilot-notice";
import { isApptPick, useCopilot } from "./use-copilot";
import { CopilotActPicker } from "../components/copilot-act-pick";
import { renderWithProviders } from "../test-utils";

/**
 * #686 done-means 1 — A CONFIRM BUTTON APPEARS ONLY FOR A PROPOSAL. The dock (My day, the doctor desk)
 * renders the picker exactly when `useCopilot().pick` is set, so the gate is the hook's: an answer
 * with no signed proposal never offers a Confirm, even when its payload looks like a pick. The tap
 * posts the proposal back unchanged and the server's answer replaces the card.
 */
const REMINDER = { kind: "reminderPick", text: "see bed 12", at: "2026-11-20T10:30:00.000Z", repeat: "none", proposal: 0 };
const PROPOSAL = { v: 1, id: "p0", tool: "reminder_set", sig: "s" };

let askReply: unknown;
function stub(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    if (key === "GET /api/copilot/notice") return new Response(JSON.stringify({ seen: true }), { status: 200 });
    if (key === "POST /api/copilot/ask") return new Response(JSON.stringify(askReply), { status: 200 });
    if (key === "POST /api/copilot/confirm") {
      return new Response(JSON.stringify({ outcome: "expired", answer: { key: "copilot.answer.actExpired", params: {} } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
}
const confirmBodies = (): unknown[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => init?.method === "POST" && String(input) === "/api/copilot/confirm")
  .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

function Dock(): React.ReactElement {
  const c = useCopilot();
  return (
    <>
      <button type="button" onClick={() => { c.ask("remind me"); }}>ask</button>
      <p data-testid="answer">{c.answer}</p>
      {!c.busy && c.pick !== null && !isApptPick(c.pick.pick) && (
        <CopilotActPicker pick={c.pick.pick} proposals={c.pick.proposals} busy={c.busy}
          onConfirm={(p) => { void c.confirm(p); }} onDismiss={c.clearPick} />
      )}
    </>
  );
}

async function askWith(reply: unknown): Promise<void> {
  askReply = reply;
  renderWithProviders(<Dock />);
  await userEvent.click(screen.getByText("ask"));
  await waitFor(() => expect(screen.getByTestId("answer")).not.toBeEmptyDOMElement());
}

describe("#686 — the confirm tap on the web dock", () => {
  beforeEach(() => { setToken("t"); resetCopilotNoticeForTests(); stub(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a plain answer offers no Confirm", async () => {
    await askWith({ answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "phrasebook", intent: "queue_depth" });
    expect(screen.queryByTestId("copilot-act-confirm-go")).toBeNull();
  });

  it("a pick-shaped payload with no signed proposal offers no Confirm", async () => {
    await askWith({ answer: { key: "copilot.answer.reminderPick", params: {}, payload: REMINDER }, source: "phrasebook", intent: "reminder_set" });
    expect(screen.queryByTestId("copilot-act-confirm-go")).toBeNull();
  });

  it("a proposal offers one Confirm; the tap posts THAT proposal and the server's answer replaces the card", async () => {
    await askWith({
      answer: { key: "copilot.answer.reminderPick", params: {}, payload: REMINDER }, source: "phrasebook", intent: "reminder_set",
      proposals: [PROPOSAL],
    });
    expect(screen.getAllByTestId("copilot-act-confirm-go")).toHaveLength(1);
    await userEvent.click(screen.getByTestId("copilot-act-confirm-go"));
    await waitFor(() => expect(confirmBodies()).toEqual([{ proposal: PROPOSAL }]));
    await waitFor(() => expect(screen.queryByTestId("copilot-act-pick")).toBeNull());
    expect(screen.getByTestId("answer")).not.toHaveTextContent("copilot.answer");
  });
});
