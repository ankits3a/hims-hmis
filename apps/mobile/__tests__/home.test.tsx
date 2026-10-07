import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "abhi.owner", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
const mockBio = { enrolled: false, success: true };
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => mockBio.enrolled),
  isEnrolledAsync: jest.fn(async () => mockBio.enrolled),
  authenticateAsync: jest.fn(async () => ({ success: mockBio.success })),
}));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

const MIN = 60_000;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN).toISOString();
const approval = (id: string, typeKey: string, minutesAgo: number, amountPaise: number | null, dueInMin: number | null) => ({
  id, typeKey, amountPaise, requestedAt: iso(minutesAgo), dueAt: dueInMin === null ? null : new Date(Date.now() + dueInMin * MIN).toISOString(),
  requesterName: "Asha Devi", requestNote: "visit cancelled before consultation", patient: { id: "p", uhid: "U00110048", name: "Sanjay Mahto", alias: "Patient 48", restricted: false },
});

type Route = { status: number; body?: unknown } | "offline";
function server(perms: string[], routes: Record<string, Route | (() => Route)>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.split("?")[0] ?? path}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    const hit = routes[key];
    const r = typeof hit === "function" ? hit() : hit;
    if (r === "offline") throw new TypeError("Network request failed");
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, sent: (key: string) => calls.filter((c) => c.key === key) };
}
function Gate() { const { state } = useSession(); return state.status === "signedIn" ? <SeatHome /> : null; }
async function mount(fetcher: typeof fetch) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
const OWNER = ["approvals.requests.read", "approvals.requests.decide", "roster.read"];

describe("app home — the first screen (owner 2026-10-07)", () => {
  beforeEach(() => { _forgetHomeForTests(); mockPush.mockClear(); mockBio.enrolled = false; mockBio.success = true; });

  it("nothing pending reads calm, and every screen the role allows is still under My work", async () => {
    const { fetcher } = server(["roster.read", "opd.vitals.record"], {});
    await mount(fetcher);
    expect(await screen.findByTestId("home-calm")).toHaveTextContent(/Nothing needs you right now/);
    expect(screen.getByTestId("seat-vitals")).toBeTruthy();
    expect(screen.getByTestId("seat-onNow")).toBeTruthy();
    expect(screen.getByTestId("seat-myDuties")).toBeTruthy();
    expect(screen.queryByTestId("seat-counter")).toBeNull();
  });

  it("approvals lead with their clocks — the overdue refund first — and five show, the rest behind See all", async () => {
    const items = [
      approval("a1", "tariff_revision", 125, null, 22 * 60), approval("a2", "billing_refund_owner", 320, 3_200_000, -200),
      approval("a3", "materials_po_approval", 40, 18_450_000, 23 * 60), approval("a4", "billing_discount", 70, 15_000, 50),
      approval("a5", "billing_refund", 10, 120_000, 110), approval("a6", "patient_merge", 5, null, 23 * 60), approval("a7", "billing_discount", 100, 20_000, 20),
    ];
    const { fetcher } = server(OWNER, { "GET /approvals": { status: 200, body: { items, total: 7 } } });
    await mount(fetcher);
    await screen.findByTestId("needs-all");
    const cards = screen.getAllByTestId("need-approval");
    expect(cards).toHaveLength(5);
    expect(cards[0]).toHaveTextContent(/Refund ₹32,000 · above the manager's limit/);
    expect(cards[0]).toHaveTextContent(/overdue 3 h 20 min/);
    expect(cards[0]).toHaveTextContent(/asked by Asha Devi/);
    expect(screen.getByTestId("needs-all")).toHaveTextContent("See all (7)");
    await fireEvent.press(screen.getByTestId("needs-all"));
    expect(screen.getAllByTestId("need-approval")).toHaveLength(7);
  });

  it("a money approval from the card: the note is required, the password stands in for a fingerprint, the step-up goes first, then the decision", async () => {
    const { fetcher, sent } = server(OWNER, {
      "GET /approvals": { status: 200, body: { items: [approval("a2", "billing_refund", 130, 120_000, -10)], total: 1 } },
      "POST /auth/step-up": { status: 200, body: { ok: true, goodUntil: new Date(Date.now() + 120_000).toISOString() } },
      "POST /approvals/a2/approve": { status: 201, body: { status: "granted" } },
    });
    await mount(fetcher);
    await fireEvent.press(await screen.findByTestId("need-act-approval-review"));
    expect(await screen.findByTestId("approval-amount")).toHaveTextContent("₹1,200.00");
    expect(screen.getByTestId("approval-clock")).toHaveTextContent(/overdue 10 min/);
    expect(screen.getByTestId("approval-fine")).toHaveTextContent(/Fingerprint is asked before a money approval/);

    await fireEvent.press(screen.getByTestId("approval-approve"));
    expect(await screen.findByTestId("approval-error")).toHaveTextContent(/Write a note first/);
    expect(sent("POST /auth/step-up")).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId("approval-note"), "checked with billing");
    await fireEvent.press(screen.getByTestId("approval-approve"));
    // No fingerprint on this phone: the password is asked for, and nothing has been sent yet.
    await fireEvent.changeText(await screen.findByTestId("approval-password"), "s3cret-pass-xyz");
    expect(sent("POST /approvals/a2/approve")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("approval-approve"));
    await waitFor(() => { expect(sent("POST /approvals/a2/approve")).toHaveLength(1); });
    expect(sent("POST /auth/step-up").map((c) => c.body)).toEqual([{ method: "password", password: "s3cret-pass-xyz" }]);
    expect(sent("POST /approvals/a2/approve")[0]!.body).toEqual({ note: "checked with billing" });
    expect(await screen.findByTestId("home-said")).toHaveTextContent(/Approved\. It is recorded/);
  });

  it("with a fingerprint enrolled the phone asks it, tells the server, and a non-money request asks for none", async () => {
    const { fetcher, sent } = server(OWNER, {
      "GET /approvals": { status: 200, body: { items: [approval("m1", "patient_merge", 20, null, 23 * 60), approval("r1", "billing_refund", 30, 120_000, 90)], total: 2 } },
      "POST /auth/step-up": { status: 200, body: { ok: true, goodUntil: "x" } },
      "POST /approvals/r1/reject": { status: 201, body: { status: "rejected" } },
      "POST /approvals/m1/approve": { status: 201, body: { status: "granted" } },
    });
    await mount(fetcher);
    const reviews = await screen.findAllByTestId("need-act-approval-review");
    mockBio.enrolled = true; // a fingerprint is enrolled on this phone
    await fireEvent.press(reviews[0]!); // the refund: its deadline is nearer
    await fireEvent.changeText(await screen.findByTestId("approval-note"), "duplicate request");
    await fireEvent.press(screen.getByTestId("approval-decline"));
    await waitFor(() => { expect(sent("POST /approvals/r1/reject")).toHaveLength(1); });
    expect(sent("POST /auth/step-up").map((c) => c.body)).toEqual([{ method: "biometric" }]);

    await fireEvent.press((await screen.findAllByTestId("need-act-approval-review"))[1]!); // the merge
    await fireEvent.changeText(await screen.findByTestId("approval-note"), "same person");
    await fireEvent.press(screen.getByTestId("approval-approve"));
    await waitFor(() => { expect(sent("POST /approvals/m1/approve")).toHaveLength(1); });
    expect(sent("POST /auth/step-up")).toHaveLength(1); // still one: the merge asked for none
  });

  it("a decision that does not reach the server says nothing was decided, and is not queued", async () => {
    let up = true;
    const { fetcher, sent } = server(OWNER, {
      "GET /approvals": { status: 200, body: { items: [approval("m1", "patient_merge", 20, null, 23 * 60)], total: 1 } },
      "POST /approvals/m1/approve": () => (up ? { status: 201, body: { status: "granted" } } : "offline"),
    });
    await mount(fetcher);
    await fireEvent.press(await screen.findByTestId("need-act-approval-review"));
    await fireEvent.changeText(await screen.findByTestId("approval-note"), "same person");
    up = false;
    await fireEvent.press(screen.getByTestId("approval-approve"));
    expect(await screen.findByTestId("approval-error")).toHaveTextContent(/did not reach the server — nothing was decided/);
    expect(sent("POST /approvals/m1/approve")).toHaveLength(1);
    expect(screen.getByTestId("approval-sheet")).toBeTruthy(); // still open, the note still typed
  });

  it("blind count: the cashier's Collected tile says 'After your count' and no rupee figure is on the screen", async () => {
    const { fetcher } = server(["opd.visits.open"], {
      "GET /me/desk": { status: 200, body: { cards: [{ key: "billing.myCollections", stats: [{ key: "desk.billing.receipts", value: "14" }] }] } },
      "GET /me/brief": { status: 200, body: { totals: { "opd.visitsOpened": 12, "billing.receipts": 14 }, clauses: [], series: [] } },
    });
    await mount(fetcher);
    expect(await screen.findByTestId("tile-locked")).toHaveTextContent("After your count · 14 receipts");
    expect(screen.queryByText(/₹/)).toBeNull();
  });

  it("a supervisor gets one extra card — My team — and a person with no team gets none", async () => {
    const { fetcher } = server(["roster.read"], {
      "GET /me/team": { status: 200, body: { members: [{ userId: "u1", name: "Asha Devi", today: { "opd.visitsOpened": 12 }, month: { "opd.visitsOpened": 240 }, daysWithActivity: 20 }] } },
    });
    await mount(fetcher);
    expect(await screen.findByTestId("home-team")).toHaveTextContent(/My team today/);
    expect(screen.getByTestId("team-u1")).toHaveTextContent(/Asha Devi/);
    expect(screen.getByTestId("team-u1")).toHaveTextContent(/12 visits today · 240 in 30 days/);
  });

  it("a cover request is answered from the card: Yes goes to the roster, and the card says what happened", async () => {
    const req = {
      requestId: "c1", kind: "cover", status: "asked", crossUnit: false, owner: { userId: "u2", name: "Dr. Ritu Kumari" }, counterpart: { userId: "u-owner", name: "Me" },
      requestedBy: { userId: "u2", name: "Dr. Ritu Kumari" }, duty: { assignmentId: "d1", startsAt: new Date(Date.now() + 3 * 60 * MIN).toISOString(), endsAt: new Date(Date.now() + 15 * 60 * MIN).toISOString(), istDate: "2026-10-09", night: true, mode: null, kind: "duty" },
      give: null, note: null, requestedAt: iso(30), answeredAt: null, decidedBy: null, decidedAt: null, refusedRule: null, check: null, youMay: { answer: true, approve: false, withdraw: false },
    };
    const { fetcher, sent } = server(["roster.read"], {
      "GET /roster/my-duties": { status: 200, body: { at: iso(0), days: [], you: {}, duties: [], onTake: null, mySr: null, requests: [req] } },
      "POST /roster/covers/c1/answer": { status: 201, body: { ok: true } },
    });
    await mount(fetcher);
    const card = await screen.findByTestId("need-cover_request");
    expect(card).toHaveTextContent(/Cover request · Dr\. Ritu Kumari/);
    expect(card).toHaveTextContent(/due in 2 h 59 min|due in 3 h 0 min/);
    await fireEvent.press(screen.getByTestId("need-act-cover_request-yes"));
    await waitFor(() => { expect(sent("POST /roster/covers/c1/answer").map((c) => c.body)).toEqual([{ accept: true }]); });
    expect(await screen.findByTestId("home-said")).toHaveTextContent(/You said yes/);
  });

  it("no network at all: the last home stays with 'as of', and an approval cannot be sent", async () => {
    let up = true;
    const items = [approval("m1", "patient_merge", 20, null, 23 * 60)];
    const route = (ok: Route) => () => (up ? ok : "offline");
    const { fetcher, sent } = server(OWNER, {
      "GET /approvals": route({ status: 200, body: { items, total: 1 } }),
      "GET /me/brief": route({ status: 404 }), "GET /me/desk": route({ status: 404 }), "GET /me/team": route({ status: 404 }), "GET /roster/my-duties": route({ status: 404 }),
    });
    await mount(fetcher);
    await screen.findByTestId("need-approval");
    up = false;
    // Pull down to refresh, with the network gone.
    await act(async () => { (screen.getByTestId("home-scroll").props as { refreshControl: { props: { onRefresh: () => void } } }).refreshControl.props.onRefresh(); });
    expect(await screen.findByTestId("home-offline")).toHaveTextContent(/No network — showing the last numbers/);
    expect(screen.getByTestId("home-as-of")).toHaveTextContent(/^as of \d\d:\d\d$/);
    await fireEvent.press(screen.getByTestId("need-act-approval-review"));
    await fireEvent.changeText(await screen.findByTestId("approval-note"), "same person");
    expect(screen.getByTestId("approval-offline")).toBeTruthy();
    expect(screen.getByTestId("approval-approve")).toBeDisabled();
    expect(sent("POST /approvals/m1/approve")).toHaveLength(0);
  });
});
