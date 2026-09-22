import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import en from "../locales/en.json";
import hi from "../locales/hi.json";
import { ApprovalsInbox } from "./approvals-inbox";
import { APPROVAL_KINDS, ageOf, decisionErrorKey } from "./approval-kinds";

/**
 * APPROVALS-UX — the owner's inbox. The owner said the old screen confused him: six unlabelled
 * columns, a machine key where the request should be, a ULID where the patient should be, minutes
 * as a bare integer, no amount, and a typed note forced even to approve. These tests pin the
 * replacement to what a person reads, not to how the page is built.
 */

const navigate = vi.hoisted(() => vi.fn());
/**
 * `useNavigate` only. PHASE O T3 moved this suite onto `renderWithRouter`, so `useSearch` — which
 * the screen now calls to read `?focus=` — resolves against a REAL memory router rather than a
 * stub. Mocking it too would make the deep-link arrival a test of the mock; the focus case lives
 * in `approvals-inbox-focus.test.tsx` and drives the query string through the history.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const REFUND = {
  id: "ap-1", typeKey: "billing_refund", instanceId: "wi-1", requesterId: "u-sunita", requesterName: "Sunita Verma",
  approverRole: "billing_manager", urgencyClass: "urgent", actedFirst: false,
  subjectType: "billing_refund", subjectId: "inv-1", patientId: "p-1", encounterId: null, payeeId: null,
  patient: { id: "p-1", uhid: "U00110234", name: "Ramesh Kumar", alias: null, restricted: false },
  amountPaise: 125000, cumulativePatientPaise: 125000, cumulativePayeePaise: null,
  requestNote: "Patient cancelled the ultrasound after paying", status: "pending",
  decisionNote: null, decidedBy: null, decidedByName: null, decidedAt: null, requestedAt: minutesAgo(12),
};

const DISCOUNT = {
  ...REFUND, id: "ap-2", typeKey: "billing_discount", urgencyClass: "routine", requesterId: "u-anil", requesterName: "Anil Sharma",
  patientId: "p-3", patient: { id: "p-3", uhid: "U00110412", name: "Lakshmi Devi", alias: null, restricted: false },
  amountPaise: 250000, cumulativePatientPaise: 450000, requestNote: "Senior citizen", requestedAt: minutesAgo(185),
};

type Reply = { status: number; body: unknown };
type Handler = Reply | ((url: string, body: string) => Reply);
type Seen = { method: string; url: string; body: string };

function mockRoutes(handlers: Record<string, Handler>, seen: Seen[] = []): Seen[] {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ method, url, body });
    const h = handlers[`${method} ${url.split("?")[0]!}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    const reply = typeof h === "function" ? h(url, body) : h;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return seen;
}

const me = (id: string, hospital: string[]): Reply => ({
  status: 200, body: { actor: { type: "user", id }, permissions: { hospital, scoped: { department: {}, floor: {} } } },
});
const OWNER = me("u-owner", ["approvals.requests.read", "approvals.requests.decide", "patients.read"]);
const list = (items: unknown[]): Reply => ({ status: 200, body: { items, total: items.length } });

function mount(handlers: Record<string, Handler>, seen?: Seen[]): Seen[] {
  const out = mockRoutes({ "GET /api/auth/me": OWNER, ...handlers }, seen);
  setToken("t-1");
  renderWithRouter(<ApprovalsInbox />);
  return out;
}

beforeEach(() => { navigate.mockReset(); });
afterEach(() => { setToken(null); localStorage.clear(); vi.unstubAllGlobals(); });

describe("the waiting list says what is asked, in plain words", () => {
  it("amount in rupees, the patient, who asked, how long ago — and no machine key or id", async () => {
    mount({ "GET /api/approvals": list([REFUND]) });

    const refund = await screen.findByRole("article", { name: "Refund ₹1,250 to Ramesh Kumar" });
    expect(within(refund).getByRole("heading", { name: "Refund ₹1,250 to Ramesh Kumar" })).toBeInTheDocument();
    expect(within(refund).getByText("UHID U00110234")).toBeInTheDocument();
    expect(within(refund).getByText("Asked by Sunita Verma")).toBeInTheDocument();
    expect(within(refund).getByText("12 min ago")).toBeInTheDocument();
    expect(within(refund).getByText("Patient cancelled the ultrasound after paying")).toBeInTheDocument();
    expect(within(refund).getByText("Money goes back to the patient.")).toBeInTheDocument();
    expect(within(refund).getByText("Urgent")).toBeInTheDocument();
    // What the old screen printed and nobody could read.
    expect(screen.queryByText(/billing_refund/)).not.toBeInTheDocument();
    expect(screen.queryByText(/inv-1/)).not.toBeInTheDocument();
    // The waiting count is on the tab.
    expect(screen.getByRole("tab", { name: /Waiting for you\s*1/ })).toBeInTheDocument();
  });

  it("a routine request carries no urgency badge — urgency is shown only when it matters", async () => {
    mount({ "GET /api/approvals": list([DISCOUNT]) });
    const discount = await screen.findByRole("article", { name: "Discount of ₹2,500 on Lakshmi Devi's bill" });
    expect(within(discount).queryByText("Urgent")).not.toBeInTheDocument();
    expect(within(discount).queryByText("Routine")).not.toBeInTheDocument();
  });

  /*
    C-12: cumulativePatientPaise is that day's total of this type for this patient INCLUDING this
    request, pending + granted. The line names only the OTHERS (₹4,500 − ₹2,500 = ₹2,000), and a
    request that is the only one that day gets no line at all.
  */
  it("the same-day line counts only the other requests, and is absent when there are none", async () => {
    mount({ "GET /api/approvals": list([DISCOUNT, REFUND]) });
    const discount = await screen.findByRole("article", { name: "Discount of ₹2,500 on Lakshmi Devi's bill" });
    expect(within(discount).getByText(
      "Also asked for this patient the same day: ₹2,000 more (approved or still waiting) — ₹4,500 in all with this one.",
    )).toBeInTheDocument();
    const refund = screen.getByRole("article", { name: "Refund ₹1,250 to Ramesh Kumar" });
    expect(within(refund).queryByText(/Also asked/)).not.toBeInTheDocument();
  });

  it("a request missing a value its sentence needs falls back to the label, never a sentence with a hole", async () => {
    mount({ "GET /api/approvals": list([{ ...DISCOUNT, amountPaise: null, cumulativePatientPaise: null }]) });
    expect(await screen.findByRole("heading", { name: "Discount" })).toBeInTheDocument();
    expect(screen.queryByText(/null|undefined|\{\{/)).not.toBeInTheDocument();
  });

  it("a type this screen has no words for still renders, as an approval request", async () => {
    mount({ "GET /api/approvals": list([{ ...REFUND, typeKey: "future_module_thing", amountPaise: null }]) });
    expect(await screen.findByRole("heading", { name: "Approval request" })).toBeInTheDocument();
    expect(screen.getByText("This kind of request has no description on this screen yet.")).toBeInTheDocument();
  });

  it("an API that does not send names yet still renders — 'a staff member', no crash", async () => {
    const bare: Record<string, unknown> = { ...REFUND };
    delete bare.requesterName;
    delete bare.decidedByName;
    delete bare.patient;
    mount({ "GET /api/approvals": list([bare]) });
    expect(await screen.findByText("Asked by a staff member")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Refund" })).toBeInTheDocument();
  });

  it("a sealed patient appears by the alias the server sent, with no link to a record they may not open", async () => {
    mount({
      "GET /api/approvals": list([{ ...REFUND, patient: { id: "p-9", uhid: "U00110999", name: null, alias: "Patient S-14", restricted: true } }]),
    });
    const refund = await screen.findByRole("article", { name: "Refund ₹1,250 to Patient S-14" });
    await within(refund).findByRole("button", { name: "Approve" }); // auth has loaded
    expect(within(refund).queryByRole("button", { name: "Open patient record" })).not.toBeInTheDocument();
  });

  it("an open patient links to their record", async () => {
    const user = userEvent.setup();
    mount({ "GET /api/approvals": list([REFUND]) });
    await user.click(await screen.findByRole("button", { name: "Open patient record" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/patients/$patientId", params: { patientId: "p-1" } });
  });

  it("shows a friendly empty state", async () => {
    mount({ "GET /api/approvals": list([]) });
    expect(await screen.findByText("Nothing waiting for you")).toBeInTheDocument();
    expect(screen.getByText(/When someone asks for a discount, a refund or any other approval/)).toBeInTheDocument();
  });

  it("says in words when the list cannot be loaded, and offers to try again", async () => {
    mount({ "GET /api/approvals": { status: 500, body: { message: "boom" } } });
    expect(await screen.findByText("Could not load the approvals. Check the connection and try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("deciding", () => {
  /*
    The server REQUIRES a note on approve (decisions.ts note_required) and that guard stays; the
    screen fills it in. One tap opens the confirm step with "Approved as requested" already in the
    field, one tap sends it.
  */
  it("approve is one confirm step with the note already filled in, and the card leaves with a confirmation", async () => {
    const user = userEvent.setup();
    let pending = [REFUND];
    const seen = mount({
      "GET /api/approvals": () => list(pending),
      "POST /api/approvals/ap-1/approve": () => { pending = []; return { status: 201, body: { status: "granted" } }; },
    });

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve this request?" });
    expect(within(dialog).getByText("Refund ₹1,250 to Ramesh Kumar")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Note — saved with your decision")).toHaveValue("Approved as requested");
    const confirm = within(dialog).getByRole("button", { name: "Approve" });
    expect(confirm).toBeEnabled();

    await user.click(confirm);

    expect(await screen.findByRole("status")).toHaveTextContent("Approved — Refund ₹1,250 to Ramesh Kumar");
    const post = seen.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/approvals/ap-1/approve");
    expect(JSON.parse(post!.body)).toEqual({ note: "Approved as requested" });
    await waitFor(() => { expect(screen.queryByRole("article", { name: /Refund/ })).not.toBeInTheDocument(); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a preset chip replaces the approve note", async () => {
    const user = userEvent.setup();
    const seen = mount({
      "GET /api/approvals": list([REFUND]),
      "POST /api/approvals/ap-1/approve": { status: 201, body: { status: "granted" } },
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Approved — one time only" }));
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => { expect(seen.some((c) => c.method === "POST")).toBe(true); });
    expect(JSON.parse(seen.find((c) => c.method === "POST")!.body)).toEqual({ note: "Approved — one time only" });
  });

  it("reject needs a reason: blocked until one is picked or typed, and a chip fills it in", async () => {
    const user = userEvent.setup();
    const seen = mount({
      "GET /api/approvals": list([REFUND]),
      "POST /api/approvals/ap-1/reject": { status: 201, body: { status: "rejected" } },
    });
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this request?" });
    const reason = within(dialog).getByLabelText("Why are you rejecting it?");
    const confirm = within(dialog).getByRole("button", { name: "Reject" });
    expect(reason).toHaveValue("");
    expect(confirm).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Amount is too high" }));
    expect(reason).toHaveValue("Amount is too high");
    await user.type(reason, " — ask for 10%");
    expect(confirm).toBeEnabled();
    expect(seen.some((c) => c.method === "POST")).toBe(false);

    await user.click(confirm);
    expect(await screen.findByRole("status")).toHaveTextContent("Rejected — Refund ₹1,250 to Ramesh Kumar");
    expect(JSON.parse(seen.find((c) => c.method === "POST")!.body)).toEqual({ note: "Amount is too high — ask for 10%" });
  });

  it("the requester's own request says why they cannot decide it, and offers no buttons", async () => {
    mount({ "GET /api/approvals": list([{ ...REFUND, requesterId: "u-owner" }]) });
    const refund = await screen.findByRole("article", { name: /Refund/ });
    expect(await within(refund).findByText("You asked for this one, so someone else has to approve it.")).toBeInTheDocument();
    expect(within(refund).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("without the decide permission, the list is readable and says why there are no buttons", async () => {
    mockRoutes({ "GET /api/auth/me": me("u-viewer", ["approvals.requests.read"]), "GET /api/approvals": list([REFUND]) });
    setToken("t-1");
    renderWithRouter(<ApprovalsInbox />);
    expect(await screen.findByText("You can see these requests, but your login cannot approve or reject them.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  /*
    The server's own words are "segregation-of-duties violation: requester_approver". The approver
    reads a sentence instead, and since pressing again would be refused again, the only way out is
    Close.
  */
  it("a 403 SoD refusal reads in plain words and leaves only Close", async () => {
    const user = userEvent.setup();
    mount({
      "GET /api/approvals": list([REFUND]),
      "POST /api/approvals/ap-1/approve": { status: 403, body: { statusCode: 403, message: "segregation-of-duties violation: requester_approver", error: "Forbidden" } },
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("You asked for this one, so someone else has to approve it.");
    expect(within(dialog).queryByText(/segregation/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    // Two buttons answer to "Close": the dialog's corner ✕ (screen-reader label) and the footer's.
    const closers = within(dialog).getAllByRole("button", { name: "Close" });
    expect(closers.some((b) => b.textContent === "Close")).toBe(true);
    await user.click(closers.find((b) => b.textContent === "Close")!);
    await waitFor(() => { expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); });
  });

  it("a request somebody else already decided says so, and refreshes the list", async () => {
    const user = userEvent.setup();
    let pending = [REFUND];
    const seen = mount({
      "GET /api/approvals": () => list(pending),
      "POST /api/approvals/ap-1/approve": () => { pending = []; return { status: 409, body: { statusCode: 409, message: "approval ap-1 is already granted" } }; },
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Someone has already decided this one. The list has been refreshed.");
    await waitFor(() => { expect(seen.filter((c) => c.method === "GET" && c.url.startsWith("/api/approvals")).length).toBeGreaterThan(1); });
  });

  it("a dropped connection can be retried: the button stays", async () => {
    const user = userEvent.setup();
    mount({
      "GET /api/approvals": list([REFUND]),
      "POST /api/approvals/ap-1/approve": { status: 502, body: {} },
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not save your decision. Check the connection and try again.");
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});

describe("decided recently", () => {
  it("shows granted and rejected together, newest decision first, with who decided and why", async () => {
    const user = userEvent.setup();
    const granted = { ...REFUND, id: "g-1", status: "granted", decidedBy: "u-owner", decidedByName: "Dr. Ankit Chaudhary", decisionNote: "Approved as requested", decidedAt: minutesAgo(90) };
    const rejected = { ...DISCOUNT, id: "r-1", status: "rejected", decidedBy: "u-owner", decidedByName: "Dr. Ankit Chaudhary", decisionNote: "Not as per hospital policy", decidedAt: minutesAgo(20) };
    const seen = mount({
      "GET /api/approvals": (url) => {
        if (url.includes("status=granted")) return list([granted]);
        if (url.includes("status=rejected")) return list([rejected]);
        return list([]);
      },
    });
    await screen.findByText("Nothing waiting for you");
    await user.click(screen.getByRole("tab", { name: "Decided recently" }));

    const articles = await screen.findAllByRole("article");
    expect(articles.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Discount of ₹2,500 on Lakshmi Devi's bill",
      "Refund ₹1,250 to Ramesh Kumar",
    ]);
    expect(within(articles[0]!).getByText("Rejected by Dr. Ankit Chaudhary")).toBeInTheDocument();
    expect(within(articles[0]!).getByText("Not as per hospital policy")).toBeInTheDocument();
    expect(within(articles[1]!).getByText("Approved by Dr. Ankit Chaudhary")).toBeInTheDocument();
    expect(within(articles[1]!).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(seen.map((c) => c.url)).toEqual(expect.arrayContaining([
      "/api/approvals?status=granted&limit=25", "/api/approvals?status=rejected&limit=25",
    ]));
  });
});

describe("the words behind the screen", () => {
  /*
    Every type key the server registers (measured 2026-09-19 across the modules' approval-types.ts)
    has a label, a sentence and an explanation in BOTH locales, and each sentence carries exactly the
    placeholders the map says it needs. i18n-keys.test.ts cannot see these: they are looked up by a
    computed key.
  */
  const SERVER_TYPES = [
    "billing_discount", "billing_clearance_discount", "billing_credit_extension", "billing_refund", "billing_variance",
    "lab_release_unpaid", "patient_merge", "patient_unmerge", "materials_stock_adjustment",
    "materials_near_expiry_acceptance", "materials_vendor_bank_change", "imaging_definition_publish",
    "ot_definition_publish", "ot_deposit_exception", "tariff_revision", "membership_grace_honor",
  ];

  it("knows every type the server registers", () => {
    expect(Object.keys(APPROVAL_KINDS).sort()).toEqual([...SERVER_TYPES].sort());
  });

  it.each([["en", en], ["hi", hi]] as const)("%s has a label, sentence and explanation for each, with the right placeholders", (_lang, bundle) => {
    const kinds = (bundle.inbox as unknown as { kinds: Record<string, Record<string, string>> }).kinds;
    for (const [key, needs] of Object.entries(APPROVAL_KINDS)) {
      const words = kinds[key];
      expect(words, key).toBeDefined();
      for (const field of ["label", "ask", "explain"]) expect(typeof words![field], `${key}.${field}`).toBe("string");
      const placeholders = [...words!.ask!.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      expect(placeholders, `${key}.ask`).toEqual([...needs].sort());
    }
  });

  it("ages read as people say them", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const at = (m: number): string => new Date(now - m * 60_000).toISOString();
    expect(ageOf(at(0), now)).toEqual({ key: "inbox.age.justNow", count: 0 });
    expect(ageOf(at(1), now)).toEqual({ key: "inbox.age.minutes", count: 1 });
    expect(ageOf(at(59), now)).toEqual({ key: "inbox.age.minutes", count: 59 });
    expect(ageOf(at(60), now)).toEqual({ key: "inbox.age.hours", count: 1 });
    expect(ageOf(at(23 * 60 + 59), now)).toEqual({ key: "inbox.age.hours", count: 23 });
    expect(ageOf(at(24 * 60), now)).toEqual({ key: "inbox.age.yesterday", count: 1 });
    expect(ageOf(at(48 * 60), now)).toEqual({ key: "inbox.age.days", count: 2 });
    expect(ageOf(at(-5), now)).toEqual({ key: "inbox.age.justNow", count: 0 }); // a server clock ahead of this one
  });

  it("maps each refusal to a sentence by status, consulting the message only to tell two apart", () => {
    const err = (status: number, message: string): ApiError => new ApiError(status, { statusCode: status, message });
    expect(decisionErrorKey(err(403, "segregation-of-duties violation: requester_approver"))).toBe("inbox.errors.ownRequest");
    expect(decisionErrorKey(err(403, "missing permission approvals.requests.decide"))).toBe("inbox.errors.notAllowed");
    expect(decisionErrorKey(err(409, "approval x is already rejected"))).toBe("inbox.errors.alreadyDecided");
    expect(decisionErrorKey(err(409, "instance x was moved concurrently"))).toBe("inbox.errors.alreadyDecided");
    expect(decisionErrorKey(err(409, "transition pending→granted allows roles: owner"))).toBe("inbox.errors.wrongRole");
    expect(decisionErrorKey(err(404, "unknown approval x"))).toBe("inbox.errors.gone");
    expect(decisionErrorKey(err(400, "a decision note is mandatory"))).toBe("inbox.errors.noteRequired");
    expect(decisionErrorKey(new TypeError("Failed to fetch"))).toBe("inbox.errors.network");
  });
});
