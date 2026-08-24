import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { MergeReview } from "./merge-review";

const SEARCH_PLACEHOLDER = /Phone number, UHID, or name/;

const LEFT_HIT = {
  id: "p-1", uhid: "HMS0000000001", name: "Asha Devi", phone: "9876543210",
  sex: "female", dob: "1990-04-02", isConfidential: false, hasPhoto: false,
};
const RIGHT_HIT = {
  id: "p-2", uhid: "HMS0000000002", name: "Asha Devi", phone: "9876500000",
  sex: "female", dob: "1990-04-02", isConfidential: false, hasPhoto: false,
};

// Identical on every field except phone — teeth: only the phone row may show "differs".
const LEFT_PATIENT = {
  id: "p-1", uhid: "HMS0000000001", name: "Asha Devi", phone: "9876543210",
  dob: "1990-04-02T00:00:00.000Z", sex: "female", addressLine: "12 MG Road",
  abhaAddress: "asha@abdm", abhaNumber: null,
};
const RIGHT_PATIENT = {
  id: "p-2", uhid: "HMS0000000002", name: "Asha Devi", phone: "9876500000",
  dob: "1990-04-02T00:00:00.000Z", sex: "female", addressLine: "12 MG Road",
  abhaAddress: "asha@abdm", abhaNumber: null,
};

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}

async function pickBoth(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const first = screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!;
  await user.type(first, "asha");
  await user.click(await screen.findByRole("button", { name: /HMS0000000001/ }));

  const second = screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!;
  await user.type(second, "asha");
  await user.click(await screen.findByRole("button", { name: /HMS0000000002/ }));

  await screen.findByLabelText(/Record A/);
}

const baseRoutes = {
  "GET /api/patients/search": { items: [LEFT_HIT, RIGHT_HIT] },
  "GET /api/patients/p-1": { patient: LEFT_PATIENT, resolvedFrom: null },
  "GET /api/patients/p-2": { patient: RIGHT_PATIENT, resolvedFrom: null },
  "GET /api/patients/p-1/allergies": { items: [] },
  "GET /api/patients/p-2/allergies": { items: [] },
};

describe("MergeReview", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the side-by-side comparison once both records are picked, highlighting only the differing phone row", async () => {
    stubFetch(baseRoutes);
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await pickBoth(user);

    const phoneRow = (await screen.findByText("Mobile number")).closest("tr");
    expect(phoneRow).not.toBeNull();
    expect(within(phoneRow!).getByText("differs")).toBeInTheDocument();

    // Teeth: the identical name row must NOT be flagged — proves the highlight is driven by
    // an actual left-vs-right comparison, not a highlight-everything implementation.
    const nameRow = screen.getByText("Full name").closest("tr");
    expect(nameRow).not.toBeNull();
    expect(within(nameRow!).queryByText("differs")).toBeNull();
  });

  it("submitting the merge request posts winnerId, loserId, and the typed note", async () => {
    stubFetch({
      ...baseRoutes,
      "POST /api/patients/merge-requests": { mergeRequestId: "mr-1", approvalId: "ap-1", instanceId: "wi-1" },
      "GET /api/patients/merge-requests/mr-1": {
        request: {
          id: "mr-1", winnerId: "p-1", loserId: "p-2", status: "requested",
          requestNote: "same person, double registration",
          snapshot: { winnerBefore: LEFT_PATIENT, loserBefore: RIGHT_PATIENT },
        },
        approvalStatus: "pending",
        unmergeApprovalStatus: null,
      },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await pickBoth(user);
    await user.click(screen.getByLabelText(/Record A/));
    await user.type(screen.getByLabelText("Why is this the same person?"), "same person, double registration");
    await user.click(screen.getByRole("button", { name: "Request merge" }));

    await waitFor(() =>
      expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/api/patients/merge-requests")).toBe(true),
    );
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/api/patients/merge-requests");
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ winnerId: "p-1", loserId: "p-2", note: "same person, double registration" });
  });

  it("the tracker shows the polled approvalStatus and disables Execute while it is pending", async () => {
    stubFetch({
      ...baseRoutes,
      "POST /api/patients/merge-requests": { mergeRequestId: "mr-1", approvalId: "ap-1", instanceId: "wi-1" },
      "GET /api/patients/merge-requests/mr-1": {
        request: {
          id: "mr-1", winnerId: "p-1", loserId: "p-2", status: "requested",
          requestNote: "same person, double registration",
          snapshot: { winnerBefore: LEFT_PATIENT, loserBefore: RIGHT_PATIENT },
        },
        approvalStatus: "pending",
        unmergeApprovalStatus: null,
      },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await pickBoth(user);
    await user.click(screen.getByLabelText(/Record A/));
    await user.type(screen.getByLabelText("Why is this the same person?"), "same person, double registration");
    await user.click(screen.getByRole("button", { name: "Request merge" }));

    expect(await screen.findByText("pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execute merge" })).toBeDisabled();
  });
});
