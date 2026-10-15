import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "./api";
import { resetCopilotNoticeForTests } from "./copilot-notice";
import { screenSlug, useCopilot } from "./use-copilot";
import { CopilotNoticeHost } from "../components/copilot-notice";
import { renderWithProviders } from "../test-utils";

/**
 * E0.1 — the staff notice (owner ruling 2026-10-10: notice first). Done-means: a user who has not
 * seen it sees it before the first ask; after dismissing, never again; the ask goes out either way
 * (the ledger row is the server's — `apps/core/test/copilot-ledger.e2e.test.ts`).
 */
type Reply = { status: number; body: unknown };
function stub(seen: boolean): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const routes: Record<string, Reply> = {
      "GET /api/copilot/notice": { status: 200, body: { seen } },
      "POST /api/copilot/notice": { status: 204, body: null },
      "POST /api/copilot/ask": { status: 200, body: { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null } },
    };
    const r = routes[key];
    if (r === undefined) return new Response("{}", { status: 404 });
    return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status });
  }));
}
const calls = (key: string): RequestInit[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input)}` === key)
  .map(([, init]) => init ?? {});

function AskBox(): React.ReactElement {
  const c = useCopilot();
  return <button type="button" onClick={() => { c.ask("kitna wait hai"); }}>ask</button>;
}
const page = (): ReturnType<typeof renderWithProviders> => renderWithProviders(<><AskBox /><CopilotNoticeHost /></>);

describe("the copilot staff notice", () => {
  beforeEach(() => { setToken("t"); resetCopilotNoticeForTests(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows before the first ask for a user who has not seen it, and the ask still goes out", async () => {
    stub(false);
    page();
    expect(await screen.findByTestId("copilot-notice")).toHaveTextContent(
      "Copilot questions are logged for 180 days for safety and quality. No one sees a per-person list.",
    );
    expect(calls("POST /api/copilot/ask")).toHaveLength(0);
    await userEvent.click(screen.getByText("ask"));
    await waitFor(() => { expect(calls("POST /api/copilot/ask")).toHaveLength(1); });
  });

  it("after dismissing, it is stored on the server and never shown again", async () => {
    stub(false);
    const { unmount } = page();
    await userEvent.click(await screen.findByTestId("copilot-notice-ok"));
    expect(screen.queryByTestId("copilot-notice")).toBeNull();
    await waitFor(() => { expect(calls("POST /api/copilot/notice")).toHaveLength(1); });
    unmount();
    page(); // another screen on the same page load
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("copilot-notice")).toBeNull();
  });

  it("is never shown to a user the server says has seen it", async () => {
    stub(true);
    page();
    await waitFor(() => { expect(calls("GET /api/copilot/notice")).toHaveLength(1); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("copilot-notice")).toBeNull();
  });

  it("the ask names its screen by the route's first segment only — never a path that carries an id", () => {
    expect(screenSlug("/patients/01HXYZ")).toBe("patients");
    expect(screenSlug("/my-day")).toBe("my-day");
    expect(screenSlug("/")).toBe("home");
  });
});
