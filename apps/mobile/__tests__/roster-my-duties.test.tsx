import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { RosterMyDuties } from "../src/screens/roster-my-duties";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  let v: string | null = JSON.stringify({ token: "t1", username: "asha.devi" });
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async () => v),
    setItemAsync: jest.fn(async (_k: string, val: string) => { v = val; }),
    deleteItemAsync: jest.fn(async () => { v = null; }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));

type Reply = { status: number; body?: unknown } | "offline";
type Route = (body: unknown, url: string) => Reply;

function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const ME = { actor: { type: "user", id: "u-me" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } };
// Tuesday 6 Oct 2026, 08:30 IST.
const AT = "2026-10-06T03:00:00.000Z";
const DAYS = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"];

const duty = (id: string, istDate: string, over: Record<string, unknown> = {}) => ({
  assignmentId: id, userId: "u-me", positionKey: "ward_jr", positionLabel: "Ward JR",
  startsAt: `${istDate}T03:30:00.000Z`, endsAt: `${istDate}T12:00:00.000Z`, istDate, night: false, mode: "site", kind: "duty",
  departmentId: "d-med", teamId: "t1", teamName: "General Medicine Unit I", activities: ["ward"], upcoming: true, ...over,
});
const NIGHT_THU = duty("a-thu", "2026-10-08", { night: true, startsAt: "2026-10-08T14:30:00.000Z", endsAt: "2026-10-09T02:30:00.000Z" });
const SAT = duty("a-sat", "2026-10-10", { activities: ["opd"] });
const request = (over: Record<string, unknown> = {}) => ({
  requestId: "r1", kind: "cover", status: "asked", crossUnit: false,
  owner: { userId: "u-me", name: "Dr. Meena Joshi" }, counterpart: { userId: "u-b", name: "Dr. Bhavna Shah" }, requestedBy: { userId: "u-me", name: "Dr. Meena Joshi" },
  duty: SAT, give: null, note: null, requestedAt: AT, answeredAt: null, decidedBy: null, decidedAt: null, refusedRule: null, check: null,
  youMay: { answer: false, approve: false, withdraw: true }, ...over,
});
const mine = (over: Record<string, unknown> = {}) => ({
  at: AT, days: DAYS,
  you: { name: "Dr. Meena Joshi", grade: "jr2", positionKey: "ward_jr", unitName: "General Medicine Unit I", departmentName: "General Medicine" },
  duties: [duty("a-tue", "2026-10-06", { upcoming: false }), NIGHT_THU, SAT],
  onTake: { teamId: "t3", name: "General Medicine Unit III", endsAt: "2026-10-07T02:30:00.000Z" },
  mySr: { userId: "u-sr", name: "Dr. Kavya Nair", phone: "9876500011" },
  requests: [],
  ...over,
});
const OPTIONS = {
  duty: SAT, ownerName: "Dr. Meena Joshi", openRequestId: null,
  canTake: [
    { userId: "u-b", name: "Dr. Bhavna Shah", grade: "jr2", teamId: "t1", teamName: "General Medicine Unit I", crossUnit: false, nextDay: { istDate: "2026-10-11", duty: null }, swaps: [duty("b-mon", "2026-10-12", { userId: "u-b" })] },
    { userId: "u-c", name: "Dr. Chirag Mehta", grade: "jr1", teamId: "t2", teamName: "General Medicine Unit II", crossUnit: true, nextDay: { istDate: "2026-10-11", duty: { night: true, positionKey: "ward_jr" } }, swaps: [] },
  ],
  cannot: [
    { userId: "u-d", name: "Dr. Deepa Rao", grade: "jr2", teamId: "t1", teamName: "General Medicine Unit I", reason: { ruleKey: "night_one_in_three", severity: "block", params: {} }, near: { istDate: "2026-10-11", night: true } },
    { userId: "u-e", name: "Dr. Esha Gupta", grade: "jr3", teamId: "t1", teamName: "General Medicine Unit I", reason: { ruleKey: "unavailable", severity: "unavailable", params: {} }, near: null },
  ],
};

function world(m: unknown = mine(), extra: Record<string, Route> = {}) {
  const state = { m };
  const s = server({
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /roster/my-duties": () => ({ status: 200, body: state.m }),
    "GET /roster/duties/a-sat/cover-options": () => ({ status: 200, body: OPTIONS }),
    ...extra,
  });
  return { ...s, state };
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <RosterMyDuties /> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => { mockPush.mockClear(); });

describe("my duties, on a phone", () => {
  it("greets me, says what today is, tonight, and which unit is on take", async () => {
    const w = world();
    await mount(w.fetcher);
    expect(await screen.findByTestId("my-duties-greeting")).toHaveTextContent("Good morning, Dr. Meena");
    expect(screen.getByTestId("my-duties-home")).toHaveTextContent(/General Medicine · Unit I · JR-2/);
    const today = screen.getByTestId("my-duties-today");
    expect(today).toHaveTextContent(/TODAY/);
    expect(today).toHaveTextContent(/Ward/);
    expect(today).toHaveTextContent(/09:00 to 17:30 · Unit I/);
    expect(screen.getByTestId("my-duties-tonight")).toHaveTextContent("Tonight: free");
    expect(today).toHaveTextContent(/Unit III is on take/);
  });

  it("lays out the rest of the week: a night, the REST the day after it, a day off — and 'I can't do this' only on a duty still ahead", async () => {
    const w = world();
    await mount(w.fetcher);
    expect(await screen.findByTestId("my-day-2026-10-08")).toHaveTextContent(/THU.*8.*Ward night.*20:00 to 08:00/);
    expect(screen.getByTestId("my-day-2026-10-09")).toHaveTextContent(/FRI.*9.*Rest.*After your night\. Nobody can roster you before 20:00/);
    expect(screen.getByTestId("my-day-2026-10-07")).toHaveTextContent(/WED.*7.*Off.*No duty/);
    expect(screen.getByTestId("my-day-2026-10-10")).toHaveTextContent(/SAT.*10.*OPD/);
    expect(screen.getByTestId("cant-a-thu")).toBeTruthy();
    expect(screen.getByTestId("cant-a-sat")).toBeTruthy();
    // Today's duty (not upcoming) offers nothing.
    expect(screen.queryByTestId("cant-a-tue")).toBeNull();
  });

  it("'I can't do this' opens the duty's page: who CAN take it, and for the rest WHY NOT — leave is only ever 'unavailable'", async () => {
    const w = world();
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("cant-a-sat"));
    expect(await screen.findByTestId("can-u-b")).toHaveTextContent(/Dr\. Bhavna Shah/);
    expect(screen.getByTestId("cover-picker")).toHaveTextContent(/Saturday 10 Oct, day/);
    expect(screen.getByTestId("cover-picker")).toHaveTextContent(/OPD, 09:00 to 17:30\. Here is who could take it without breaking a rule/);
    expect(screen.getByTestId("can-u-b")).toHaveTextContent(/JR-2 · Unit I · free Saturday, off Sunday/);
    expect(screen.getByTestId("can-u-b")).toHaveTextContent(/Or swap: you take their Monday's duty/);
    expect(screen.getByTestId("can-u-c")).toHaveTextContent(/JR-1 · Unit II · free Saturday, night Sunday/);
    expect(screen.getByTestId("can-u-c")).toHaveTextContent(/Another unit, so the HOD also approves/);
    expect(screen.queryByTestId("swap-u-c")).toBeNull();
    expect(screen.getByTestId("cannot-u-d")).toHaveTextContent(/Dr\. Deepa Rao · Unit I.*Has Sunday night\. This would be a second night in three\./);
    expect(screen.getByTestId("cannot-u-e")).toHaveTextContent(/Unavailable on those days\./);
  });

  it("asking one person sends ONE request for that duty and says the duty is still mine", async () => {
    const w = world(mine(), { "POST /roster/covers": () => ({ status: 201, body: { requestId: "r9" } }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("cant-a-sat"));
    await fireEvent.press(await screen.findByTestId("ask-u-b"));
    expect(await screen.findByTestId("my-duties-flash")).toHaveTextContent("Asked. The duty is still yours until it is approved.");
    expect(w.of("POST /roster/covers")).toHaveLength(1);
    expect(w.of("POST /roster/covers")[0]!.body).toEqual({ assignmentId: "a-sat", counterpartId: "u-b" });
    expect(screen.queryByTestId("cover-picker")).toBeNull();
  });

  it("a swap names the duty they give back", async () => {
    const w = world(mine(), { "POST /roster/covers": () => ({ status: 201, body: { requestId: "r9" } }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("cant-a-sat"));
    await fireEvent.press(await screen.findByTestId("swap-u-b"));
    await waitFor(() => expect(w.of("POST /roster/covers")).toHaveLength(1));
    expect(w.of("POST /roster/covers")[0]!.body).toEqual({ assignmentId: "a-sat", counterpartId: "u-b", counterpartAssignmentId: "b-mon" });
  });

  it("a refused request shows the server's reason in a sentence and stays on the page; with no signal nothing is queued", async () => {
    let reply: Reply = { status: 409, body: { statusCode: 409, message: "x", code: "cover_already_asked" } };
    const w = world(mine(), { "POST /roster/covers": () => reply });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("cant-a-sat"));
    await fireEvent.press(await screen.findByTestId("ask-u-b"));
    expect(await screen.findByTestId("cover-error")).toHaveTextContent("Somebody has already been asked to take this duty. Wait for their answer, or withdraw that request first.");
    expect(screen.getByTestId("cover-picker")).toBeTruthy();
    reply = "offline";
    await fireEvent.press(screen.getByTestId("ask-u-c"));
    await waitFor(() => expect(screen.getByTestId("cover-error")).toHaveTextContent("The server could not be reached. Nothing was changed."));
    expect(screen.getByTestId("cover-picker")).toBeTruthy();
    expect(screen.queryByTestId("my-duties-flash")).toBeNull();
    // Two taps, two sends — and no third from a retry the person did not make.
    expect(w.of("POST /roster/covers")).toHaveLength(2);
  });

  it("a duty somebody has already been asked about is not offered twice; my request card says where it stands, and I can withdraw it", async () => {
    const w = world(mine({ requests: [request()] }), { "POST /roster/covers/r1/withdraw": () => ({ status: 201, body: { ok: true } }) });
    await mount(w.fetcher);
    const card = await screen.findByTestId("my-request-r1");
    expect(card).toHaveTextContent(/Asked: Dr\. Bhavna Shah, for Saturday's duty/);
    expect(card).toHaveTextContent(/Until then, Saturday's duty is still yours\./);
    expect(screen.queryByTestId("cant-a-sat")).toBeNull();
    expect(screen.getByTestId("cant-a-thu")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("withdraw-r1"));
    expect(await screen.findByTestId("my-duties-flash")).toHaveTextContent("The request is withdrawn.");
    expect(w.of("POST /roster/covers/r1/withdraw")).toHaveLength(1);
  });

  it("a request made OF me carries the server's check, and Yes sends accept:true", async () => {
    const theirs = request({
      requestId: "r2", owner: { userId: "u-b", name: "Dr. Bhavna Shah" }, counterpart: { userId: "u-me", name: "Dr. Meena Joshi" },
      duty: duty("b-sun", "2026-10-11", { userId: "u-b", night: true, startsAt: "2026-10-11T14:30:00.000Z", endsAt: "2026-10-12T02:30:00.000Z" }),
      check: { ruleKey: "rest_after_duty", severity: "warn", params: {} }, youMay: { answer: true, approve: false, withdraw: false },
    });
    const w = world(mine({ requests: [theirs] }), { "POST /roster/covers/r2/answer": () => ({ status: 201, body: { ok: true } }) });
    await mount(w.fetcher);
    const card = await screen.findByTestId("asked-of-you-r2");
    expect(card).toHaveTextContent(/Dr\. Bhavna Shah asks you to take Sunday 11 Oct, night, 20:00 to 08:00\./);
    expect(screen.getByTestId("check-r2")).toHaveTextContent("This would cut the rest that must follow a night.");
    // It is not also listed as a request of mine.
    expect(screen.queryByTestId("my-request-r2")).toBeNull();
    await fireEvent.press(screen.getByTestId("answer-yes-r2"));
    expect(await screen.findByTestId("my-duties-flash")).toHaveTextContent("You said yes. It now waits for approval.");
    expect(w.of("POST /roster/covers/r2/answer")[0]!.body).toEqual({ accept: true });
  });

  it("an answer the server refuses says why — the request was already decided", async () => {
    const theirs = request({ requestId: "r2", owner: { userId: "u-b", name: "Dr. Bhavna Shah" }, counterpart: { userId: "u-me", name: "x" }, youMay: { answer: true, approve: false, withdraw: false } });
    const w = world(mine({ requests: [theirs] }), { "POST /roster/covers/r2/answer": () => ({ status: 409, body: { statusCode: 409, message: "x", code: "cover_not_open" } }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("answer-no-r2"));
    expect(await screen.findByTestId("my-duties-error")).toHaveTextContent("This request has already been answered or decided.");
    expect(w.of("POST /roster/covers/r2/answer")[0]!.body).toEqual({ accept: false });
  });

  it("D6: 'Call my SR' only when the server sent my SR's number; the board is one tap away", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const w = world();
    const view = await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("call-my-sr"));
    expect(open).toHaveBeenCalledWith("tel:9876500011");
    await fireEvent.press(screen.getByTestId("to-on-now"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "onNow" } });
    open.mockRestore();
    void view;
  });

  it("no SR number, no call button; somebody not posted to a unit is told why the page is empty", async () => {
    const w = world(mine({ mySr: { userId: "u-sr", name: "Dr. Kavya Nair", phone: null }, duties: [], onTake: null, you: { name: "Asha Devi", grade: null, positionKey: null, unitName: null, departmentName: null } }));
    await mount(w.fetcher);
    expect(await screen.findByTestId("not-posted")).toHaveTextContent(/not posted to a unit/);
    expect(screen.queryByTestId("call-my-sr")).toBeNull();
    expect(screen.getByTestId("my-duties-today")).toHaveTextContent(/No duty today/);
  });

  it("with no signal it says so and offers to try again", async () => {
    let up = false;
    const w = world(mine(), { "GET /roster/my-duties": () => (up ? { status: 200, body: mine() } : "offline") });
    await mount(w.fetcher);
    expect(await screen.findByTestId("my-duties-offline")).toBeTruthy();
    up = true;
    await fireEvent.press(screen.getByTestId("my-duties-retry"));
    expect(await screen.findByTestId("my-duties-greeting")).toBeTruthy();
  });

  it("reads in Hindi with the web's own sentences", async () => {
    const hi = require("../src/locales/hi.json");
    const w = world();
    await mount(w.fetcher, "hi");
    expect(await screen.findByTestId("my-duties-tonight")).toHaveTextContent(hi.rosterMyDuties.tonightFree);
    expect(screen.getByTestId("my-day-2026-10-07")).toHaveTextContent(/बुध/);
  });
});
