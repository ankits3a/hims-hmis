import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MyLeave } from "./my-leave";
import type { WireLeaveToDecide, WireMyLeave } from "../lib/leave-api";

/**
 * E2.2 (decision 0069) — My leave: ask, see where it stands and why it was refused, take it back; a
 * department head approves, or refuses only with a reason. The server's answers are stubbed.
 */
const REFUSED: WireMyLeave = {
  id: "a1", kind: "CL", from: "2026-11-02", to: "2026-11-03", days: 2, status: "rejected",
  reason: "family function", refusal: "Two residents already away that week", decidedBy: "Dr. R. Prasad", decidedAt: "2026-10-12T05:00:00.000Z", canCancel: false,
};
const WAITING: WireMyLeave = { ...REFUSED, id: "a2", from: "2026-11-10", to: "2026-11-10", days: 1, status: "requested", refusal: null, decidedBy: null, decidedAt: null, canCancel: true };
const THEIRS: WireLeaveToDecide = {
  id: "b1", userId: "jr", name: "Dr. Sandeep Yadav", department: "General Medicine", kind: "EL",
  from: "2026-11-05", to: "2026-11-07", days: 3, reason: "sister's wedding", requestedAt: "2026-10-11T05:00:00.000Z",
};

describe("MyLeave (E2.2)", () => {
  const posted: { url: string; body: unknown }[] = [];
  let toDecide: WireLeaveToDecide[];
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    toDecide = [THEIRS];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        posted.push({ url: raw, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
        if (raw.includes("/decide")) toDecide = [];
        return new Response(JSON.stringify({ absenceId: "new", ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = raw.endsWith("/roster/leave/mine") ? [WAITING, REFUSED]
        : raw.endsWith("/roster/leave/to-decide") ? toDecide
          : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists my requests with their state, and a refused one says who refused it and why", async () => {
    renderWithProviders(<MyLeave />);
    const refused = await screen.findByTestId("my-leave-a1");
    expect(within(refused).getByTestId("my-leave-status")).toHaveTextContent("Not approved");
    expect(within(refused).getByTestId("my-leave-refusal")).toHaveTextContent("Not approved by Dr. R. Prasad: Two residents already away that week");
    expect(within(refused).queryByTestId("my-leave-cancel")).toBeNull();
    const waiting = screen.getByTestId("my-leave-a2");
    expect(within(waiting).getByTestId("my-leave-status")).toHaveTextContent("Waiting");
    await userEvent.click(within(waiting).getByTestId("my-leave-cancel"));
    expect(posted.map((p) => p.url)).toEqual([expect.stringContaining("/roster/leave/a2/cancel")]);
  });

  it("asks for leave with a kind, the days and an optional reason", async () => {
    renderWithProviders(<MyLeave />);
    await screen.findByTestId("leave-ask");
    await userEvent.selectOptions(screen.getByTestId("leave-kind"), "EL");
    await userEvent.type(screen.getByTestId("leave-reason"), "sister's wedding");
    await userEvent.click(screen.getByTestId("leave-send"));
    expect(await screen.findByTestId("leave-sent")).toHaveTextContent("Sent to your head");
    const sent = posted.find((p) => p.url.endsWith("/roster/leave"))!;
    expect(sent.body).toMatchObject({ kind: "EL", reason: "sister's wedding" });
    expect((sent.body as { from: string; to: string }).to >= (sent.body as { from: string }).from).toBe(true);
  });

  it("a decider approves at once, but Refuse needs a reason before it sends, and sends that reason", async () => {
    renderWithProviders(<MyLeave />);
    const row = await screen.findByTestId("decide-b1");
    expect(row).toHaveTextContent("Dr. Sandeep Yadav");
    expect(row).toHaveTextContent("Reason: sister's wedding");
    await userEvent.click(within(row).getByTestId("decide-refuse"));
    expect(within(row).getByTestId("decide-refuse-send")).toBeDisabled();
    await userEvent.type(within(row).getByTestId("decide-note"), "OPD short that week");
    await userEvent.click(within(row).getByTestId("decide-refuse-send"));
    expect(posted).toEqual([{ url: expect.stringContaining("/roster/leave/b1/decide"), body: { approve: false, note: "OPD short that week" } }]);
  });

  it("a person with nothing to decide sees no To decide section", async () => {
    toDecide = [];
    renderWithProviders(<MyLeave />);
    await screen.findByTestId("my-leave-a1");
    expect(screen.queryByTestId("leave-to-decide")).toBeNull();
  });
});
