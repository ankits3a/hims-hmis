import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
import { PaperConsultsScreen } from "../src/screens/paper-consults";
import { AlertsScreen } from "../src/screens/alerts";
import { SessionProvider, useSession } from "../src/session";
import { focusHome, takeHomeFocus } from "../src/home/focus";
import { coldOf } from "../src/home/cache";
import { buildHome } from "../src/home/model";
import { headerOf } from "../src/home/profile";

/**
 * ═══ APP HOME, ROUND 2 (decision 0043) — what round 1 left open, each as a row ═══
 * the header names the PERSON; the front desk's and the scribe's own cards; what I asked for; a "no"
 * to a cover carries a reason (home.test.tsx); paper consultations decided on the phone; the bell;
 * a notification's tap landing on its card; and a home that survives a closed app with COUNTS ONLY.
 */
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, val: string) => { mockStore.set(k, val); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

const MIN = 60_000;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN).toISOString();
type Route = { status: number; body?: unknown } | "offline";
type Profile = { username: string; fullName: string | null; roles: string[] } | undefined;
function server(perms: string[], routes: Record<string, Route | (() => Route)>, profile?: Profile) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.split("?")[0] ?? path}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const hit = routes[key];
    const r = typeof hit === "function" ? hit() : hit;
    if (r === "offline") throw new TypeError("Network request failed");
    if (key === "GET /auth/me" && r === undefined) {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } }, ...(profile === undefined ? {} : { profile }) }), { status: 200 });
    }
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, sent: (key: string) => calls.filter((c) => c.key === key) };
}
function Gate({ what }: { what: "home" | "paper" | "alerts" }) {
  const { state } = useSession();
  if (state.status !== "signedIn") return null;
  return what === "home" ? <SeatHome /> : what === "paper" ? <PaperConsultsScreen /> : <AlertsScreen />;
}
async function mount(fetcher: typeof fetch, what: "home" | "paper" | "alerts" = "home") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate what={what} /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
const signIn = (): void => { mockStore.clear(); mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi", since: "2026-10-07T03:30:00.000Z" })); };
const DESK = ["opd.visits.open", "opd.visits.read", "patients.read", "patients.register", "opd.appointments.read", "approvals.requests.create"];
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const hhmm = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN + 5.5 * 3_600_000).toISOString().slice(11, 16);
const t = (k: string, v?: Record<string, string | number>) => `${k}${v === undefined ? "" : JSON.stringify(v)}`;

describe("app home round 2 — the header, the desks' own cards, what I asked for", () => {
  beforeEach(() => { signIn(); _forgetHomeForTests(); mockPush.mockClear(); takeHomeFocus(); });

  it("greets the PERSON by name with what they are here as — the username only when the account has no name", async () => {
    const { fetcher } = server(["opd.vitals.record", "roster.read"], {}, { username: "vivek.kumar", fullName: "Vivek Kumar", roles: ["vitals_desk"] });
    await mount(fetcher);
    expect(await screen.findByTestId("home-name")).toHaveTextContent("Vivek Kumar");
    expect(screen.getByTestId("signed-in-as")).toHaveTextContent("Vitals bay");
    // The rule, away from the screen: a doctor's department and unit; the hospital for who reads all of it; else a role in words.
    const tr = (k: string) => (({ "home.role.hospital": "Hospital · all departments", "home.role.cashier": "Cash counter", "home.role.front_office": "Front desk" } as Record<string, string>)[k] ?? k);
    expect(headerOf({ username: "c", fullName: "Dr. Chandan Kumar", roles: ["doctor"] }, "c", { doctor: { displayName: "Dr Chandan", departmentName: "General Medicine", unit: "Unit I" }, hospitalWide: false }, tr))
      .toEqual({ name: "Dr. Chandan Kumar", line: "General Medicine · Unit I" });
    expect(headerOf({ username: "o", fullName: "Abhay Kumar", roles: ["owner"] }, "o", { doctor: null, hospitalWide: true }, tr)).toEqual({ name: "Abhay Kumar", line: "Hospital · all departments" });
    expect(headerOf({ username: "a", fullName: "Asha Devi", roles: ["front_office", "cashier", "admin"] }, "a", { doctor: null, hospitalWide: false }, tr)).toEqual({ name: "Asha Devi", line: "Cash counter · Front desk" });
    expect(headerOf(undefined, "asha.devi", null, tr)).toEqual({ name: "asha.devi", line: null });
    expect(headerOf({ username: "x", fullName: null, roles: ["new_role_key"] }, "x", null, tr).line).toBe("New role key");
  });

  it("the bell shows how many alerts are unread and opens the list", async () => {
    const { fetcher } = server(["roster.read"], { "GET /alerts": { status: 200, body: { items: [], unreadCount: 3 } } });
    await mount(fetcher);
    expect(await screen.findByTestId("home-bell-count")).toHaveTextContent("3");
    await fireEvent.press(screen.getByTestId("home-bell"));
    expect(mockPush).toHaveBeenCalledWith("/alerts");
  });

  it("the front desk: who I seated is still waiting (count and the oldest clock), and bookings a doctor's leave stranded", async () => {
    const section = { key: "opd.myVisits", titleKey: "report.opd.myVisits", columnKeys: ["report.col.time", "report.col.visitNo", "report.col.uhid", "report.col.patient", "report.col.type", "report.col.status"], rows: [
      [hhmm(52), "V1", "U1", "Ravi Prasad", "new", "waiting"], [hhmm(20), "V2", "U2", "Geeta Devi", "new", "registered"],
      [hhmm(90), "V3", "U3", "Lalita Devi", "new", "completed"], [hhmm(40), "V4", "U4", "Sanjay Mahto", "new", "in_consultation"],
    ] };
    const { fetcher } = server(DESK, {
      "GET /me/report": { status: 200, body: { date: today, provisional: true, sections: [section] } },
      "GET /opd/appointments": { status: 200, body: { items: [
        { id: "a1", serviceDate: today, status: "needs_rebooking" }, { id: "a2", serviceDate: "2099-01-01", status: "needs_rebooking" }, { id: "a3", serviceDate: "2020-01-01", status: "needs_rebooking" },
      ] } },
    });
    await mount(fetcher);
    const waiting = await screen.findByTestId("need-desk_waiting");
    expect(waiting).toHaveTextContent(/2 patients you opened still waiting/);
    expect(waiting).toHaveTextContent(/waiting 5[12] min/);
    expect(waiting).not.toHaveTextContent(/Ravi|Geeta/); // a card is read over a shoulder: counts, never a name
    expect(screen.getByTestId("need-rebook")).toHaveTextContent(/2 appointments to re-book/); // the one already past is not on a card
    await fireEvent.press(screen.getByTestId("need-act-rebook-rebook"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "counter" } });
  });

  it("what I asked for: pending shows with its clock and no button; an answer shows until I tap OK — and stays gone", async () => {
    const mine = { items: [
      { id: "r1", typeKey: "billing_discount", amountPaise: 15_000, status: "pending", requestedAt: iso(18), decidedAt: null, dueAt: new Date(Date.now() + 102 * MIN).toISOString() },
      { id: "r2", typeKey: "billing_refund", amountPaise: 120_000, status: "granted", requestedAt: iso(200), decidedAt: iso(5), dueAt: null },
    ] };
    const { fetcher } = server(DESK, { "GET /approvals/mine": { status: 200, body: mine } });
    await mount(fetcher);
    const cards = await screen.findAllByTestId("need-my_request");
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.props.accessibilityLabel)).toEqual(expect.arrayContaining(["my_request:r1", "my_request:r2"]));
    expect(screen.getByText(/Your request · Discount ₹150/)).toBeTruthy();
    expect(screen.getByText(/Approved — you can go ahead/)).toBeTruthy();
    expect(screen.queryByTestId("need-act-my_request-review")).toBeNull(); // mine to wait for, not to decide
    await fireEvent.press(screen.getByTestId("need-act-my_request-ok"));
    await waitFor(() => expect(screen.getAllByTestId("need-my_request")).toHaveLength(1));
    /* It is REMEMBERED on the phone (ids only), so a closed app does not bring the answer back. */
    await waitFor(() => expect(JSON.parse(mockStore.get("hmis.home.seen") ?? "[]")).toEqual(["r2"]));
  });

  it("the scribe: what doctors sent back (oldest clock) and photographed papers nobody typed — and where that work is done", async () => {
    const { fetcher } = server(["opd.prescription.transcribe", "opd.consult.paper", "opd.visits.read"], {
      "GET /opd/paper/sent-back": { status: 200, body: { toType: 3, items: [{ recheck: { askedAt: iso(65) } }, { recheck: { askedAt: iso(10) } }] } },
    });
    await mount(fetcher);
    const back = await screen.findByTestId("need-sent_back");
    expect(back).toHaveTextContent(/2 papers the doctor sent back/);
    expect(back).toHaveTextContent(/waiting 1 h 5 min/);
    expect(back.props.style).toEqual(expect.objectContaining({ borderLeftColor: expect.any(String) }));
    expect(screen.getByTestId("need-papers_to_type")).toHaveTextContent(/3 papers to type/);
    await fireEvent.press(screen.getByTestId("need-act-sent_back-where"));
    expect(await screen.findByTestId("home-said")).toHaveTextContent(/Desk scribe/);
  });

  it("a notification about approvals lands on the card: one waiting opens its sheet; the card is marked", async () => {
    const approval = { id: "a1", typeKey: "patient_merge", amountPaise: null, requestedAt: iso(30), dueAt: null, requesterName: "Asha Devi", requestNote: null, patient: null };
    const { fetcher } = server(["approvals.requests.read", "approvals.requests.decide"], { "GET /approvals": { status: 200, body: { items: [approval], total: 1 } } });
    focusHome("approval");
    await mount(fetcher);
    expect(await screen.findByTestId("approval-sheet")).toBeTruthy();
  });

  const BIG = { id: "a1", typeKey: "billing_refund", amountPaise: 3_200_000, requestedAt: iso(30), dueAt: new Date(Date.now() + 90 * MIN).toISOString(), requesterName: "Abhay Kumar", requestNote: "above the manager's limit", patient: { id: "p", uhid: "U1", name: "Lalita Devi", alias: null, restricted: false } };

  it("what the phone KEEPS of a home is counts only: no patient, no colleague, no note, no amount — and it is small", async () => {
    const { fetcher } = server(["approvals.requests.read", "approvals.requests.decide"], { "GET /approvals": { status: 200, body: { items: [BIG], total: 1 } } });
    await mount(fetcher);
    await screen.findByTestId("need-approval");
    await waitFor(() => expect(mockStore.has("hmis.home")).toBe(true));
    const kept = mockStore.get("hmis.home")!;
    expect(kept).not.toMatch(/Lalita|Abhay|3200000|32,000|limit/);
    expect(kept.length).toBeLessThan(2000);
    expect(JSON.parse(kept)).toMatchObject({ user: "u-me", cards: [{ kind: "approval", titleKey: "home.cold.approval" }] });
  });

  it("COLD AND OFFLINE: a closed app opened with no network draws that last home with 'as of' — and nothing on it can be tapped", async () => {
    const model = buildHome({ nowMs: Date.now(), permissions: ["approvals.requests.decide"], seats: [], approvals: [BIG] as never });
    mockStore.set("hmis.home", JSON.stringify(coldOf("u-me", Date.now() - 20 * MIN, model)));
    const me = { actor: { type: "user", id: "u-me" }, permissions: { hospital: ["approvals.requests.read", "approvals.requests.decide"], scoped: { department: {}, floor: {} } } };
    const offline = jest.fn(async (url: string) => {
      if (String(url).includes("/auth/me")) return new Response(JSON.stringify(me), { status: 200 });
      throw new TypeError("Network request failed");
    });
    await mount(offline as unknown as typeof fetch);
    const cold = await screen.findByTestId("home-cold");
    expect(cold).toHaveTextContent(/An approval waiting for you/);
    expect(cold).not.toHaveTextContent(/Lalita|Abhay|₹/);
    expect(screen.getByTestId("home-as-of")).toHaveTextContent(/^as of \d\d:\d\d$/);
    expect(screen.getByTestId("home-offline")).toHaveTextContent(/showing the last numbers/);
    expect(screen.queryByTestId("need-act-approval-review")).toBeNull();
    /* Somebody else's cache is not this person's home. */
    expect(JSON.parse(mockStore.get("hmis.home")!).user).toBe("u-me");
    void t;
  });
});

const LINE = { drug: "Tab Paracetamol 500", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false };
const PEN = { drug: "Tab Penicillin V 250", dose: "1 tab", route: "oral", frequency: "QID", durationDays: 7, instructions: null, noSubstitution: false };
const paperRow = (over: Record<string, unknown>) => ({
  encounterId: "E-1", visitNo: "V2610070004", tokenNo: 4, patient: { id: "P-1", uhid: "U00110049", name: "Geeta Devi", alias: null, restricted: false },
  completedVia: "paper", evidenceKind: "transcription", paperCompletedByName: "Pooja Kumari", paperCompletedAt: iso(40),
  documents: [], prescription: { lines: [LINE], transcribedByName: "Pooja Kumari" }, held: null, advisedTests: [], confirmedAt: null, recheck: null, ...over,
});

describe("my paper consultations on the phone (decision 0043)", () => {
  beforeEach(() => { signIn(); _forgetHomeForTests(); });

  it("a held medicine is DECIDED: each one given with the doctor's reason or not given — sent as the web's correction, typed lines untouched", async () => {
    const held = paperRow({ held: { lines: [PEN], alerts: [[{ kind: "allergy", hard: true, text: "Allergy on record: Penicillin" }]], note: null } });
    const { fetcher, sent } = server(["opd.consult", "opd.visits.read"], {
      "GET /opd/paper/consults": { status: 200, body: { items: [held] } },
      "POST /opd/paper/visits/E-1/correct": { status: 200, body: paperRow({}) },
    });
    await mount(fetcher, "paper");
    expect(await screen.findByTestId("paper-pill-held")).toHaveTextContent("1 held for you");
    await fireEvent.press(screen.getByTestId("paper-open-V2610070004"));
    expect(screen.getByTestId("paper-held")).toHaveTextContent(/Allergy on record: Penicillin/);
    expect(screen.getByTestId("paper-looks-right")).toBeDisabled(); // a held line is decided, not glanced at
    await fireEvent.press(screen.getByTestId("held-save"));
    expect(await screen.findByTestId("paper-said")).toHaveTextContent(/Decide each held medicine/);
    await fireEvent.press(screen.getByTestId("held-0-give"));
    await fireEvent.press(screen.getByTestId("held-save"));
    expect(await screen.findByTestId("paper-said")).toHaveTextContent(/needs your reason/);
    expect(sent("POST /opd/paper/visits/E-1/correct")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("held-0-why"), "tolerated it last year; no reaction");
    await fireEvent.press(screen.getByTestId("held-save"));
    await waitFor(() => { expect(sent("POST /opd/paper/visits/E-1/correct").map((c) => c.body)).toEqual([{ lines: [LINE, PEN], reasons: [{ lineIndex: 1, reason: "tolerated it last year; no reaction" }] }]); });
  });

  it("'do not give' sends the typed lines alone; a refusal says nothing was changed", async () => {
    const held = paperRow({ held: { lines: [PEN], alerts: [[{ kind: "allergy", hard: true, text: "Allergy on record: Penicillin" }]], note: null } });
    const { fetcher, sent } = server(["opd.consult", "opd.visits.read"], {
      "GET /opd/paper/consults": { status: 200, body: { items: [held] } },
      "POST /opd/paper/visits/E-1/correct": "offline",
    });
    await mount(fetcher, "paper");
    await fireEvent.press(await screen.findByTestId("paper-open-V2610070004"));
    await fireEvent.press(screen.getByTestId("held-0-drop"));
    await fireEvent.press(screen.getByTestId("held-save"));
    await waitFor(() => { expect(sent("POST /opd/paper/visits/E-1/correct").map((c) => c.body)).toEqual([{ lines: [LINE], reasons: [] }]); });
    expect(await screen.findByTestId("paper-said")).toHaveTextContent(/did not reach the server — nothing was changed/);
  });

  it("'looks right' and 'ask the desk to re-check' are the web's routes; a re-check needs a reason", async () => {
    const { fetcher, sent } = server(["opd.consult", "opd.visits.read"], {
      "GET /opd/paper/consults": { status: 200, body: { items: [paperRow({})] } },
      "POST /opd/paper/visits/E-1/recheck": { status: 200, body: paperRow({}) },
      "POST /opd/paper/visits/E-1/confirm": { status: 200, body: paperRow({}) },
    });
    await mount(fetcher, "paper");
    await fireEvent.press(await screen.findByTestId("paper-open-V2610070004"));
    expect(screen.getByTestId("paper-typed-by")).toHaveTextContent("Typed from your paper by Pooja Kumari");
    await fireEvent.press(screen.getByTestId("paper-ask-open"));
    expect(screen.getByTestId("paper-ask-send")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("paper-ask-reason"), "Line 1 — I wrote 650");
    await fireEvent.press(screen.getByTestId("paper-ask-send"));
    await waitFor(() => { expect(sent("POST /opd/paper/visits/E-1/recheck").map((c) => c.body)).toEqual([{ reason: "Line 1 — I wrote 650" }]); });
    await fireEvent.press(await screen.findByTestId("paper-looks-right"));
    await waitFor(() => { expect(sent("POST /opd/paper/visits/E-1/confirm")).toHaveLength(1); });
  });
});

describe("the bell's list", () => {
  beforeEach(() => { signIn(); _forgetHomeForTests(); mockPush.mockClear(); takeHomeFocus(); });

  it("lists what the server told this person; a tap marks it read and goes where it points", async () => {
    const items = [
      { id: "al1", kind: "roster_cover_asked", title: "Dr. Ritu Kumari asks you to cover", body: "Night duty, Thu 9 Oct", createdAt: iso(5), readAt: null },
      { id: "al2", kind: "approval_overdue", title: "An approval has passed its time", body: "A request waiting for your decision is past its deadline.", createdAt: iso(50), readAt: iso(40) },
    ];
    const { fetcher, sent } = server(["roster.read", "approvals.requests.read"], { "GET /alerts": { status: 200, body: { items, unreadCount: 1 } }, "POST /alerts/al1/read": { status: 201, body: {} } });
    await mount(fetcher, "alerts");
    expect(await screen.findByTestId("alert-unread-al1")).toBeTruthy();
    expect(screen.queryByTestId("alert-unread-al2")).toBeNull();
    await fireEvent.press(screen.getByTestId("alert-al1"));
    await waitFor(() => expect(sent("POST /alerts/al1/read")).toHaveLength(1));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "myDuties" } });
    await fireEvent.press(screen.getByTestId("alert-al2"));
    expect(mockPush).toHaveBeenCalledWith("/");
    expect(takeHomeFocus()).toBe("approval");
    await act(async () => undefined);
  });
});
