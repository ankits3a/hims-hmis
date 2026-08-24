import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { ApprovalsInbox } from "./approvals-inbox";

const PENDING_ROW = {
  id: "ap-1", typeKey: "patient_merge", instanceId: "wi-1", requesterId: "u1",
  approverRole: "mrd_head", urgencyClass: "urgent", actedFirst: false,
  subjectType: "patient_merge_request", subjectId: "mr-1", patientId: "p-2",
  encounterId: null, payeeId: null, amountPaise: null, cumulativePatientPaise: null,
  cumulativePayeePaise: null, requestNote: "same person, double registration",
  status: "pending", decisionNote: null, decidedBy: null, decidedAt: null,
  requestedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
};

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}

describe("ApprovalsInbox", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the stubbed pending rows from GET /approvals with an urgency badge", async () => {
    stubFetch({ "GET /api/approvals": { items: [PENDING_ROW], total: 1 } });
    renderWithProviders(<ApprovalsInbox />);

    expect(await screen.findByText("patient_merge")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByText("same person, double registration")).toBeInTheDocument();
  });

  it("shows the empty state when there is nothing pending", async () => {
    stubFetch({ "GET /api/approvals": { items: [], total: 0 } });
    renderWithProviders(<ApprovalsInbox />);

    expect(await screen.findByText("Nothing pending for your roles")).toBeInTheDocument();
  });

  it("the approve dialog blocks an empty note and posts the typed note on confirm", async () => {
    stubFetch({
      "GET /api/approvals": { items: [PENDING_ROW], total: 1 },
      "POST /api/approvals/ap-1/approve": { status: "granted" },
    });
    renderWithProviders(<ApprovalsInbox />);
    const user = userEvent.setup();
    await screen.findByText("patient_merge");

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Approve" });

    // Teeth: blocked with an empty note, and no request goes out.
    expect(confirm).toBeDisabled();
    expect(fetchCalls().some((c) => c.method === "POST")).toBe(false);

    await user.type(within(dialog).getByLabelText("Decision note (mandatory)"), "confirmed same patient");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST");
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ note: "confirmed same patient" });
  });

  it("renders a stubbed 403 SoD refusal inline instead of crashing", async () => {
    // stubFetch always answers 200; a rejected decision needs a real non-2xx response, so
    // this one test stubs fetch directly instead of going through the routes helper
    // (mirrors login.test.tsx's "sign-in-failed" case).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
        if (init?.method === "POST" && url.includes("/approve")) {
          return new Response(
            JSON.stringify({
              statusCode: 403,
              message: "requester cannot decide their own request",
              error: "Forbidden",
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ items: [PENDING_ROW], total: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    renderWithProviders(<ApprovalsInbox />);
    const user = userEvent.setup();
    await screen.findByText("patient_merge");

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Decision note (mandatory)"), "confirmed");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("requester cannot decide their own request")).toBeInTheDocument();
  });
});
