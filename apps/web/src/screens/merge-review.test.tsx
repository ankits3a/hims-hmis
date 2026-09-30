import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { MergeReview } from "./merge-review";

const SEARCH_PLACEHOLDER = /Phone number, UHID, or name/;

const LEFT_HIT = {
  id: "p-1", uhid: "HMS0000000001", name: "Asha Devi", phone: "9876543210",
  administrativeGender: "female", dob: "1990-04-02", isConfidential: false, hasPhoto: false,
};
const RIGHT_HIT = {
  id: "p-2", uhid: "HMS0000000002", name: "Asha Devi", phone: "9876500000",
  administrativeGender: "female", dob: "1990-04-02", isConfidential: false, hasPhoto: false,
};

// Identical on every field except phone — teeth: only the phone row may show "differs".
const LEFT_PATIENT = {
  id: "p-1", uhid: "HMS0000000001", name: "Asha Devi", phone: "9876543210",
  dob: "1990-04-02T00:00:00.000Z", administrativeGender: "female", addressLine: "12 MG Road",
  abhaAddress: "asha@abdm", abhaNumber: null,
};
const RIGHT_PATIENT = {
  id: "p-2", uhid: "HMS0000000002", name: "Asha Devi", phone: "9876500000",
  dob: "1990-04-02T00:00:00.000Z", administrativeGender: "female", addressLine: "12 MG Road",
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
  // "· HMS…" is a search hit's name; a requests-list row names the same UHIDs as "HMS… into HMS…".
  await user.click(await screen.findByRole("button", { name: /· HMS0000000001/ }));

  const second = screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!;
  await user.type(second, "asha");
  await user.click(await screen.findByRole("button", { name: /· HMS0000000002/ }));

  await screen.findByText("Mobile number");
}

const baseRoutes = {
  "GET /api/patients/search": { items: [LEFT_HIT, RIGHT_HIT] },
  "GET /api/patients/p-1": { patient: LEFT_PATIENT, resolvedFrom: null },
  "GET /api/patients/p-2": { patient: RIGHT_PATIENT, resolvedFrom: null },
  "GET /api/patients/p-1/allergies": { items: [] },
  "GET /api/patients/p-2/allergies": { items: [] },
};

/*
  UX-AUDIT 2026-09-28 — the three defects a real-Chromium walk of /merge found. Each test below was
  run against origin/main's merge-review.tsx first and failed there.
*/
const THIRD_HIT = { ...RIGHT_HIT, id: "p-3", uhid: "HMS0000000003" };

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
    await user.click(screen.getByLabelText(/Keep A/));
    await user.type(screen.getByLabelText("Why is this the same person?"), "same person, double registration");
    await user.click(screen.getByRole("button", { name: /Request merge/ }));

    await waitFor(() =>
      expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/api/patients/merge-requests")).toBe(true),
    );
    const posted = fetchCalls().find((c) => c.method === "POST" && c.url === "/api/patients/merge-requests");
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ winnerId: "p-1", loserId: "p-2", note: "same person, double registration" });
  });

  it("the tracker says the request is waiting on the MS, in words, and disables Run merge while it is pending", async () => {
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
    await user.click(screen.getByLabelText(/Keep A/));
    await user.type(screen.getByLabelText("Why is this the same person?"), "same person, double registration");
    await user.click(screen.getByRole("button", { name: /Request merge/ }));

    // BOARD: no enum strings — "pending" reads as who it waits on and how long is left.
    expect(await screen.findByTestId("merge-state")).toHaveTextContent(/Waiting on the Medical Superintendent/);
    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.getByRole("button", { name: "Run merge" })).toBeDisabled();
  });

  it("UX-AUDIT 2026-09-28: a record picked as A is offered disabled as B while the other record stays pickable", async () => {
    stubFetch(baseRoutes);
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await user.type(screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!, "asha");
    await user.click(await screen.findByRole("button", { name: /HMS0000000001/ }));
    await user.type(screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!, "asha");

    const sameAgain = await screen.findByRole("button", { name: /HMS0000000001/ });
    expect(sameAgain).toBeDisabled();
    expect(sameAgain).toHaveTextContent("already Record A");
    // Teeth: the OTHER record is still pickable — the guard is about identity, not about side B.
    expect(screen.getByRole("button", { name: /HMS0000000002/ })).toBeEnabled();
  });

  it("UX-AUDIT 2026-09-28: two search rows that resolve to ONE record refuse the merge before a reason is typed", async () => {
    stubFetch({
      ...baseRoutes,
      "GET /api/patients/search": { items: [LEFT_HIT, THIRD_HIT] },
      // p-3 was merged into p-1 — GET /patients/:id follows the chain to the winner.
      "GET /api/patients/p-3": { patient: LEFT_PATIENT, resolvedFrom: "p-3" },
      "GET /api/patients/p-3/allergies": { items: [] },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await user.type(screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!, "asha");
    await user.click(await screen.findByRole("button", { name: /HMS0000000001/ }));
    await user.type(screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!, "asha");
    await user.click(await screen.findByRole("button", { name: /HMS0000000003/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("one record");
    expect(screen.getByRole("alert")).toHaveTextContent("HMS0000000003 already opens HMS0000000001");
    expect(screen.queryByRole("button", { name: /Request merge/ })).toBeNull();
    expect(fetchCalls().some((c) => c.method === "POST")).toBe(false);
  });

  it("UX-AUDIT 2026-09-28: each search row carries age, sex, DOB and the masked mobile — never the full number", async () => {
    stubFetch(baseRoutes);
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await user.type(screen.getAllByPlaceholderText(SEARCH_PLACEHOLDER)[0]!, "asha");
    const a = await screen.findByRole("button", { name: /HMS0000000001/ });
    const b = screen.getByRole("button", { name: /HMS0000000002/ });
    expect(a).toHaveTextContent(/age \d+y/);
    expect(a).toHaveTextContent("Female");
    expect(a).toHaveTextContent("born 02-Apr-1990"); // BOARD: DD-Mon-YYYY
    expect(a).toHaveTextContent("•••••• 3210");
    expect(b).toHaveTextContent("•••••• 0000");
    // A list row is not a record (DD8): the full mobile must not be in the button.
    expect(a).not.toHaveTextContent("9876543210");
  });

  it("UX-AUDIT 2026-09-28: every comparison row captions its own A and B values, so a stacked phone layout stays readable", async () => {
    stubFetch(baseRoutes);
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    await pickBoth(user);

    const phoneRow = (await screen.findByText("Mobile number")).closest("tr")!;
    const [aCell, bCell] = [within(phoneRow).getByText("98765 43210").closest("td")!, within(phoneRow).getByText("98765 00000").closest("td")!];
    expect(within(aCell).getByText("Record A")).toBeInTheDocument();
    expect(within(bCell).getByText("Record B")).toBeInTheDocument();
    expect(within(phoneRow).getByText("differs")).toBeInTheDocument();
  });
  /*
    UX-AUDIT 2026-09-28 · BOARD — the owner-approved merge-review board. Each test below was run
    against origin/main's merge-review.tsx first and failed there.
  */
  const REQ = (over: Record<string, unknown> = {}) => ({
    request: {
      id: "mr-1", winnerId: "p-1", loserId: "p-2", approvalId: "ap-1", status: "requested",
      requestNote: "Lab caught two UHIDs on one sample label", requestedBy: "u-mrd", requestedAt: "2026-09-28T03:50:00.000Z",
      snapshot: { winnerBefore: LEFT_PATIENT, loserBefore: { ...RIGHT_PATIENT, name: "Asha Debi" } },
    },
    approvalStatus: "pending", unmergeApprovalStatus: null, decisionNote: null, decidedAt: null,
    requestedByName: "Sunita Rao", sealed: { winner: false, loser: false },
    ...over,
  });
  const me = (id: string, hospital: string[]) => ({ actor: { type: "user", id }, permissions: { hospital, scoped: { department: {}, floor: {} } } });
  function openRequestFromUrl(): void { window.history.pushState({}, "", "/merge?request=mr-1"); }
  afterEach(() => { window.history.pushState({}, "", "/"); });

  it("BOARD: allergies are listed with severity, severe marked, and the closing record's say they move to the survivor", async () => {
    stubFetch({
      ...baseRoutes,
      "GET /api/patients/p-1/allergies": { items: [{ id: "al-1", substance: "Penicillin", reaction: "rash", severity: "moderate", status: "active" }] },
      "GET /api/patients/p-2/allergies": { items: [{ id: "al-2", substance: "Ibuprofen", reaction: "swelling of lips", severity: "severe", status: "active" }] },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();
    await pickBoth(user);

    const row = (await screen.findByText(/Ibuprofen/)).closest("tr")!;
    expect(row).toHaveTextContent("Penicillin — rash");
    expect(within(row).getByText("severe")).toHaveClass("s");
    expect(within(row).getByText("differs")).toBeInTheDocument();
    expect(within(row).queryByText(/moves to/)).toBeNull(); // nothing moves until a survivor is chosen

    await user.click(screen.getByLabelText(/Keep A/));
    expect(within(row).getByText("→ moves to A")).toBeInTheDocument();
    // And the left lane says it before the request is sent.
    expect(screen.getByText("1 moves to A")).toBeInTheDocument();
  });

  it("BOARD: the comparison reads dates DD-Mon-YYYY and a year-only date of birth says so", async () => {
    stubFetch({
      ...baseRoutes,
      "GET /api/patients/p-2": { patient: { ...RIGHT_PATIENT, dob: "1990-01-01", dobEstimated: true }, resolvedFrom: null },
    });
    renderWithProviders(<MergeReview />);
    await pickBoth(userEvent.setup());
    const dobRow = (await screen.findByText("Date of birth")).closest("tr")!;
    expect(dobRow).toHaveTextContent("02-Apr-1990");
    expect(dobRow).toHaveTextContent("01-Jan-1990");
    expect(dobRow).toHaveTextContent("year only");
    expect(dobRow).not.toHaveTextContent("1990-04-02");
  });

  it("BOARD: the requests list puts granted first, shows time left and refusals with the MS's note, and opens a request", async () => {
    const side = (id: string, uhid: string, name: string) => ({ id, uhid, name, sealed: false });
    const item = (id: string, stage: string, over: Record<string, unknown>) => ({
      id, status: "requested", stage, approvalId: `ap-${id}`, approvalStatus: "pending", requestNote: "n", requestedBy: "u-x",
      requestedByName: "Sunita Rao", requestedAt: new Date(Date.now() - 20 * 60_000).toISOString(), dueAt: null,
      decisionNote: null, decidedByName: null, decidedAt: null, executedAt: null, unmergeApprovalStatus: null,
      winner: side("w", "HMS0000003107", `W ${id}`), loser: side("l", "HMS0000011954", `L ${id}`), ...over,
    });
    stubFetch({
      ...baseRoutes,
      "GET /api/patients/merge-requests": { items: [
        item("mr-1", "granted", { approvalStatus: "granted", decidedAt: new Date().toISOString(), winner: side("w1", "HMS0000003107", "Mohd. Irfan Qureshi") }),
        item("mr-2", "waiting", { dueAt: new Date(Date.now() + 100 * 60_000 + 20_000).toISOString(), winner: side("w2", "HMS0000006620", "Kavita Sharma") }),
        item("mr-3", "refused", { status: "refused", approvalStatus: "rejected", decisionNote: "different mothers — check the birth register", winner: side("w3", "HMS0000031540", "Baby of Pooja Meena") }),
      ] },
      "GET /api/patients/merge-requests/mr-1": REQ({ approvalStatus: "granted" }),
    });
    renderWithProviders(<MergeReview />);
    const rows = await screen.findAllByTestId("merge-list-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Mohd. Irfan Qureshi"), expect.stringContaining("Kavita Sharma"), expect.stringContaining("Baby of Pooja Meena"),
    ]);
    expect(rows[0]).toHaveTextContent("Run merge");
    expect(rows[1]).toHaveTextContent("1 h 40 m");
    expect(rows[2]).toHaveTextContent("Refused");
    expect(rows[2]).toHaveTextContent("different mothers — check the birth register");
    expect(screen.getByText("1 granted — run it")).toBeInTheDocument();
    expect(screen.getByText("1 waiting on the MS")).toBeInTheDocument();

    await userEvent.setup().click(rows[0]!);
    expect(await screen.findByText(/As captured at request/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run merge" })).toBeEnabled();
  });

  it("BOARD: the MS opens a request and approves it on this screen — frozen comparison, note required", async () => {
    setToken("t-1");
    openRequestFromUrl();
    stubFetch({
      ...baseRoutes,
      "GET /api/auth/me": me("u-ms", ["approvals.requests.read", "approvals.requests.decide", "patients.read"]),
      "GET /api/patients/merge-requests": { items: [] },
      "GET /api/patients/merge-requests/mr-1": REQ(),
      "POST /api/approvals/ap-1/approve": { status: "granted" },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();

    expect(await screen.findByText(/As captured at request · 28-Sep-2026 09:20/)).toBeInTheDocument();
    // The frozen snapshot, not the live record: the loser's name as it was when asked.
    expect(screen.getByText("Asha Debi")).toBeInTheDocument();
    expect(screen.getByText("Lab caught two UHIDs on one sample label")).toBeInTheDocument();
    expect(screen.getByText("Allergies · now")).toBeInTheDocument();

    const approve = await screen.findByRole("button", { name: /Approve/ });
    expect(approve).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refuse with reason" })).toBeDisabled();
    await user.type(screen.getByLabelText(/Your note/), "Checked the lab slip and the two OPD cards");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST" && c.url === "/api/approvals/ap-1/approve")).toBe(true));
    const posted = fetchCalls().find((c) => c.url === "/api/approvals/ap-1/approve")!;
    expect(JSON.parse(posted.body)).toEqual({ note: "Checked the lab slip and the two OPD cards" });
  });

  it("BOARD: the person who asked sees who decides instead of an Approve button, whatever roles they hold", async () => {
    setToken("t-1");
    openRequestFromUrl();
    stubFetch({
      ...baseRoutes,
      "GET /api/auth/me": me("u-mrd", ["approvals.requests.decide", "patients.read", "patients.merge"]),
      "GET /api/patients/merge-requests": { items: [] },
      "GET /api/patients/merge-requests/mr-1": REQ(),
    });
    renderWithProviders(<MergeReview />);
    expect(await screen.findByText("You asked for this merge, so someone else decides it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("BOARD: a sealed record — the MS records a break-glass before Approve is offered", async () => {
    setToken("t-1");
    openRequestFromUrl();
    stubFetch({
      ...baseRoutes,
      "GET /api/auth/me": me("u-ms", ["approvals.requests.decide", "patients.read"]),
      "GET /api/patients/merge-requests": { items: [] },
      "GET /api/patients/merge-requests/mr-1": REQ({ sealed: { winner: false, loser: true } }),
      "POST /api/auth/break-glass": { grantId: "bg-1", expiresAt: "2026-09-28T05:00:00.000Z" },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Your note/), "same person");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    await user.type(screen.getByLabelText("Why you are opening the sealed record"), "merge of a sealed record");
    await user.click(screen.getByRole("button", { name: "Record break-glass" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    const glass = fetchCalls().find((c) => c.url === "/api/auth/break-glass")!;
    expect(JSON.parse(glass.body)).toEqual({ patientId: "p-2", reason: "merge of a sealed record" });
  });

  it("BOARD: a refused request says so in brick red with the MS's note, and offers nothing to run", async () => {
    openRequestFromUrl();
    stubFetch({
      ...baseRoutes,
      "GET /api/patients/merge-requests": { items: [] },
      "GET /api/patients/merge-requests/mr-1": REQ({
        request: { ...REQ().request, status: "refused" }, approvalStatus: "rejected", decisionNote: "different mothers",
      }),
    });
    renderWithProviders(<MergeReview />);
    const refused = await screen.findByText("The Medical Superintendent refused this merge.");
    expect(refused.closest(".refuse")).toHaveTextContent("different mothers");
    expect(refused.closest(".refuse")).toHaveTextContent("the record can be asked again");
    expect(screen.queryByRole("button", { name: "Run merge" })).toBeNull();
  });

  it("BOARD: a record that already has a live request is refused before the button, naming who asked", async () => {
    stubFetch({
      ...baseRoutes,
      "GET /api/patients/merge-requests": { items: [{
        id: "mr-9", status: "requested", stage: "waiting", approvalId: "ap-9", approvalStatus: "pending", requestNote: "n",
        requestedBy: "u-x", requestedByName: "Sunita Rao", requestedAt: "2026-09-28T03:50:00.000Z", dueAt: "2026-09-28T07:50:00.000Z",
        decisionNote: null, decidedByName: null, decidedAt: null, executedAt: null, unmergeApprovalStatus: null,
        winner: { id: "p-9", uhid: "HMS0000000009", name: "Asha Devi", sealed: false },
        loser: { id: "p-2", uhid: "HMS0000000002", name: "Asha Devi", sealed: false },
      }] },
    });
    renderWithProviders(<MergeReview />);
    const user = userEvent.setup();
    await pickBoth(user);
    await user.click(screen.getByLabelText(/Keep A/));
    await user.type(screen.getByLabelText("Why is this the same person?"), "same person");
    expect(screen.getByRole("alert")).toHaveTextContent("A request for HMS0000000002 is already waiting.");
    expect(screen.getByRole("alert")).toHaveTextContent("Sunita Rao");
    expect(screen.getByRole("button", { name: /Request merge/ })).toBeDisabled();
  });
});
