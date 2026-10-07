import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { DeskOne } from "../src/screens/desk-one";
import { todayIst } from "../src/vitals/rules";
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
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
let scanned: ((data: string) => void) | null = null;
jest.mock("../src/vitals/scanner", () => ({
  Scanner: ({ open, onRead }: { open: boolean; onRead: (d: string) => void }) => { scanned = open ? onRead : null; return null; },
}));

type Reply = { status: number; body?: unknown } | "offline";
type Route = (body: unknown, url: string) => Reply;
type Call = { key: string; body: unknown; idem: string | null; url: string };

function server(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ key, body, idem: headers["Idempotency-Key"] ?? null, url: path });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, path);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const CASHIER = ["patients.read", "patients.register", "opd.visits.open", "opd.visits.read", "opd.queue.read", "opd.masters.read", "opd.paper.reprint", "roster.read", "billing.invoice.read", "billing.invoice.issue", "billing.session.own"];
const FRONT_OFFICE = ["patients.read", "patients.register", "opd.visits.open", "opd.visits.read", "opd.queue.read", "opd.masters.read", "opd.paper.reprint"];
const me = (hospital: string[]) => ({ actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });

const HIT = { id: "p1", uhid: "U00110049", name: "Geeta Devi", phone: "9876543210", administrativeGender: "female", dob: "1984-03-14T00:00:00.000Z", isConfidential: false, matchedOn: ["mobile"] };
const doc = (id: string, name: string, dept: string, waiting: number, over: Record<string, unknown> = {}) => ({
  doctor: { id, userId: `u-${id}`, displayName: name, departmentId: dept, active: true, designation: "Assistant Professor" },
  sessionId: `s-${id}`, status: "in", waitingCount: waiting, waitingVitalsCount: 1, nowServing: 3, scheduledToday: true, roomCode: "R2", avgConsultMinutes: 6, onLeaveToday: false, ...over,
});
const SUMMARY = [doc("d1", "Dr. Chandan Kumar", "med", 4), doc("d2", "Dr. Nitish Kumar Jha", "med", 1, { roomCode: "R5" }), doc("d3", "Dr. Kishore Kunal", "ort", 2, { roomCode: "R7" })];
const PRICED = {
  encounterId: "e1", visitType: "new", free: false, feeServiceId: "svc", freeReason: null, attributionCode: null, intendedPayer: "self",
  draft: {
    lines: [{ lineId: "l1", serviceId: "svc", serviceName: "OPD consultation — new", qty: 1, grossPaise: 30000, discountPaise: 0, winner: null }],
    totals: { cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPayablePaise: 30000 },
  },
  visit: { visitNo: "V2610060007", serviceDate: "2026-10-06", status: "registered", tokenNo: 7, departmentCode: "MED", feeStatus: "unsettled" },
  alreadyBilled: null,
};
const FREE = { ...PRICED, free: true, feesOff: true, draft: null, visit: { ...PRICED.visit, feeStatus: "free" } };
const WALKIN = {
  encounter: { id: "e1", visitNo: "V2610060007", patientId: "p1", status: "registered", visitType: "new", departmentId: "med", doctorId: "d2" },
  tokenNo: 7, sessionId: "s-d2", roomId: "r5", visitType: "new", patientId: "p1", registered: false,
};

function world(over: { perms?: string[]; quote?: () => unknown; flow?: unknown; cash?: () => unknown; routes?: Record<string, Route> } = {}) {
  const s = server({
    "GET /auth/me": () => ({ status: 200, body: me(over.perms ?? CASHIER) }),
    "GET /opd/config": () => ({ status: 200, body: over.flow ?? { counterSequence: "queue_first", tokenLane: "token_first" } }),
    "GET /opd/departments": () => ({ status: 200, body: { items: [{ id: "med", code: "MED", name: "General Medicine", active: true }, { id: "ort", code: "ORT", name: "Orthopaedics", active: true }] } }),
    "GET /billing/consult-terms": () => ({ status: 200, body: { consultFeeOff: false, paise: { new: 30000, renewal: 15000, revisit: null } } }),
    "GET /roster/doctor-units": () => ({ status: 200, body: [{ userId: "u-d2", short: "Unit I" }] }),
    "GET /opd/queues/summary": () => ({ status: 200, body: { items: SUMMARY } }),
    "GET /patients/search": () => ({ status: 200, body: { items: [HIT] } }),
    "GET /patients/p1": () => ({ status: 200, body: { patient: { uhid: "U00110049", name: "Geeta Devi", alias: null, dob: "1984-03-14T00:00:00.000Z", phone: "9876543210", addressLine: "Hajipur", administrativeGender: "female" } } }),
    "GET /patients/p1/linked": () => ({ status: 200, body: { numbers: ["9876543210"], total: 1, items: [{ id: "p2", uhid: "U00110050", name: "Ravi Kumar", phone: "9876543210", administrativeGender: "male", dob: "2018-01-01T00:00:00.000Z", isConfidential: false, sharedOn: ["9876543210"] }] } }),
    "GET /patients/p2": () => ({ status: 200, body: { patient: { uhid: "U00110050", name: "Ravi Kumar", alias: null, dob: "2018-01-01T00:00:00.000Z", phone: "9876543210", addressLine: null, administrativeGender: "male" } } }),
    "GET /patients/p2/linked": () => ({ status: 200, body: { numbers: [], total: 0, items: [] } }),
    "GET /opd/patients/p2/timeline": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/patients/p1/timeline": () => ({ status: 200, body: { items: [
      { encounterId: "e0", visitNo: "V2609200003", serviceDate: "2026-09-20", status: "completed", visitType: "new", doctorId: "d1", doctorName: "Dr. Chandan Kumar", departmentId: "med", departmentName: "General Medicine" },
    ] } }),
    "GET /opd/continuity": () => ({ status: 200, body: { anchor: null } }),
    "POST /opd/walk-in": () => ({ status: 201, body: WALKIN }),
    "GET /billing/visits/e1/fee-quote": () => ({ status: 200, body: (over.quote ?? (() => PRICED))() }),
    "GET /billing/sessions/current": () => ({ status: 200, body: { session: (over.cash ?? (() => ({ id: "cs1", status: "open", openedAt: "2026-10-06T03:30:00.000Z", openingFloatPaise: 50000 })))() } }),
    "GET /print/jobs": () => ({ status: 200, body: { jobs: [{ id: "j1", document: "opd_token_slip", status: "printed", attempts: 1, lastError: null, printedAt: "2026-10-06T05:00:00Z", createdAt: "2026-10-06T05:00:00Z" }] } }),
    ...(over.routes ?? {}),
  });
  return s;
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <DeskOne /> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi" = "en") {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
  await screen.findByTestId("counter-query", {}, { timeout: 5_000 });
}
async function findAndHold() {
  await fireEvent.changeText(screen.getByTestId("counter-query"), "98765 43210");
  await fireEvent.press(screen.getByTestId("counter-find"));
  await fireEvent.press(await screen.findByTestId("hit-p1"));
  await screen.findByTestId("counter-person");
}
async function seatWith(doctor = "d2") {
  await fireEvent.press(screen.getByTestId("person-seat"));
  await fireEvent.press(await screen.findByTestId("dept-med"));
  await fireEvent.press(await screen.findByTestId(`doctor-${doctor}`));
  await fireEvent.press(screen.getByTestId("seat-go"));
}

describe("Desk One on the phone", () => {
  it("finds the person, shows who shares their number, and lists their visits", async () => {
    const s = world();
    await mount(s.fetcher);
    await findAndHold();
    expect(s.of("GET /patients/search")[0]?.url).toContain("q=98765%2043210");
    expect(screen.getByTestId("counter-person")).toHaveTextContent(/Geeta Devi/);
    expect(screen.getByTestId("counter-person")).toHaveTextContent(/U00110049/);
    // "Shares a contact number" — never a relationship the record does not hold.
    expect(await screen.findByTestId("linked-p2")).toHaveTextContent(/Ravi Kumar/);
    expect(await screen.findByTestId("visit-e0")).toHaveTextContent(/General Medicine/);
    await fireEvent.press(screen.getByTestId("linked-p2"));
    await waitFor(() => expect(screen.getByTestId("counter-person")).toHaveTextContent(/Ravi Kumar/));
  });

  it("seats the patient: department, then the doctor with the unit beside the name — the server opens the visit and gives the token", async () => {
    const s = world();
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(screen.getByTestId("person-seat"));
    await fireEvent.press(await screen.findByTestId("dept-med"));
    // The shortest open line is offered first; the label beside the name is the roster's.
    expect(await screen.findByTestId("doctor-d2")).toHaveTextContent(/Unit I · Asst\. Prof\./);
    expect(screen.getByTestId("doctor-d2")).toHaveTextContent(/1 waiting/);
    expect(screen.getByTestId("seat-go")).toHaveTextContent(/Dr\. Nitish Kumar Jha/);
    await fireEvent.changeText(screen.getByTestId("seat-complaint"), " bukhar, teen din se ");
    await fireEvent.press(screen.getByTestId("seat-go"));
    expect(await screen.findByTestId("token-no")).toHaveTextContent("MED-7");
    const sent = s.of("POST /opd/walk-in")[0]!;
    expect(sent.body).toEqual({ patient: { existingId: "p1" }, departmentId: "med", doctorId: "d2", join: "queue", deskComplaint: "bukhar, teen din se" });
    expect(sent.idem).toMatch(/.{16,}/);
    // The server's own quote, line by line, and the stamp as a word.
    expect(await screen.findByTestId("bill-total")).toHaveTextContent("₹300");
    expect(screen.getByTestId("visit-kind")).toHaveTextContent("New");
    expect(screen.getByTestId("token-stamp")).toHaveTextContent("UNPAID");
    expect(await screen.findByTestId("paper-state")).toHaveTextContent(/printed/);
  });

  const anchorFor = (doctorId: string, doctorName: string) => ({ status: 200, body: { anchor: { doctorId, doctorName, seenOn: "2026-09-20", followUpDays: 7, windowEndsOn: "2026-09-27", wouldBe: "renewal", via: "consult" } } });

  it("continuity first — the doctor who saw them last is marked and picked when their line is short", async () => {
    // d2 saw them last and has 1 waiting (6 min).
    const s = world({ routes: { "GET /opd/continuity": () => anchorFor("d2", "Dr. Nitish Kumar Jha") } });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(screen.getByTestId("person-seat"));
    await fireEvent.press(await screen.findByTestId("dept-med"));
    expect(await screen.findByTestId("seat-anchor")).toHaveTextContent(/Last seen by Dr\. Nitish Kumar Jha on 20-09-2026\. With the same doctor today this is a Renewal visit\./);
    expect(screen.getByTestId("doctor-d2")).toHaveTextContent(/saw them last/);
    expect(screen.getByTestId("seat-go")).toHaveTextContent(/Dr\. Nitish Kumar Jha/);
  });

  it("…but a line past 20 minutes is said, and the shortest line stays picked — the clerk decides", async () => {
    // d1 saw them last and has 4 waiting (24 min).
    const s = world({ routes: { "GET /opd/continuity": () => anchorFor("d1", "Dr. Chandan Kumar") } });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(screen.getByTestId("person-seat"));
    await fireEvent.press(await screen.findByTestId("dept-med"));
    expect(await screen.findByTestId("seat-anchor")).toHaveTextContent(/their line is about 24 min/);
    expect(screen.getByTestId("seat-go")).toHaveTextContent(/Dr\. Nitish Kumar Jha/);
    await fireEvent.press(screen.getByTestId("doctor-d1"));
    expect(screen.getByTestId("seat-go")).toHaveTextContent(/Dr\. Chandan Kumar/);
  });

  it("a free consultation says ₹0 (समाज सेवा छूट), offers no tender and takes nothing", async () => {
    const s = world({ quote: () => FREE });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    expect(await screen.findByTestId("bill-free")).toHaveTextContent("₹0 (समाज सेवा छूट)");
    expect(screen.queryByTestId("tender")).toBeNull();
    expect(screen.queryByTestId("settle")).toBeNull();
    // Nothing was paid, so the stamp does not say PAID: it says there is nothing to pay.
    expect(screen.getByTestId("token-stamp")).toHaveTextContent("FREE");
    await fireEvent.press(screen.getByTestId("bill-done"));
    expect(await screen.findByTestId("done-word")).toBeTruthy();
    expect(s.of("POST /billing/invoices")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("next-patient"));
    expect(await screen.findByTestId("counter-query")).toBeTruthy();
  });

  it("collects by UPI only with its reference, inside the open cash session, and shows the receipt", async () => {
    const s = world({ routes: { "POST /billing/invoices": () => ({ status: 201, body: { invoiceId: "i1", invoiceNo: "INV/26-27/000101", receiptNo: "RCT/26-27/000088", totals: { netPayablePaise: 30000 } } }) } });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    await fireEvent.press(await screen.findByTestId("tender-upi"));
    await fireEvent.press(screen.getByTestId("settle"));
    expect(await screen.findByTestId("counter-error")).toHaveTextContent(/reference/i);
    expect(s.of("POST /billing/invoices")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("tender-ref"), "UPI123456");
    await fireEvent.press(screen.getByTestId("settle"));
    expect(await screen.findByTestId("issued")).toHaveTextContent(/INV\/26-27\/000101 · receipt RCT\/26-27\/000088 · ₹300 by UPI/);
    const sent = s.of("POST /billing/invoices")[0]!;
    expect(sent.body).toMatchObject({
      patientId: "p1", encounterId: "e1", lines: [{ lineId: "l1", serviceId: "svc", qty: 1 }],
      receipt: { tenders: [{ mode: "upi", amountPaise: 30000, refText: "UPI123456" }] },
    });
    expect(sent.idem).toMatch(/.{16,}/);
    expect(screen.getByTestId("token-stamp")).toHaveTextContent("PAID");
  });

  it("with no cash session open it says so, takes no money, and opens one with the float", async () => {
    let session: unknown = null;
    const s = world({
      cash: () => session,
      routes: { "POST /billing/sessions": (b) => { session = { id: "cs2", status: "open", openedAt: "2026-10-06T05:00:00.000Z", openingFloatPaise: (b as { floatPaise: number }).floatPaise }; return { status: 201, body: session }; } },
    });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    expect(await screen.findByTestId("no-cash-session")).toHaveTextContent(/No cash session is open/);
    expect(screen.queryByTestId("settle")).toBeNull();
    // Opening the session is the one primary act; leaving the fee for the billing counter is the quiet way out.
    expect(screen.getByTestId("bill-done")).toHaveTextContent(/Leave it unpaid/);
    await fireEvent.changeText(screen.getByTestId("cash-float"), "500");
    await fireEvent.press(screen.getByTestId("cash-open"));
    expect(await screen.findByTestId("tender")).toBeTruthy();
    expect(s.of("POST /billing/sessions")[0]?.body).toEqual({ floatPaise: 50000 });
    expect(screen.getByTestId("settle")).toHaveTextContent(/Collect ₹300 · Cash/);
  });

  it("a front-desk login that does not take money never asks for the quote: it says the price list's fee and where it is collected", async () => {
    const s = world({ perms: FRONT_OFFICE });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    expect(await screen.findByTestId("terms-line")).toHaveTextContent("New · ₹300");
    expect(screen.getByTestId("bill-elsewhere")).toHaveTextContent(/billing counter/);
    expect(screen.queryByTestId("settle")).toBeNull();
    expect(s.of("GET /billing/visits/e1/fee-quote")).toHaveLength(0);
    expect(s.of("GET /billing/sessions/current")).toHaveLength(0);
    expect(screen.getByTestId("token-no")).toHaveTextContent("MED-7");
  });

  it("NEVER a second bill: a lost answer is said plainly, and the retry asks the server first — already billed means nothing is sent again", async () => {
    let billed = false;
    const s = world({
      quote: () => (billed ? { ...PRICED, alreadyBilled: { invoiceId: "i1", invoiceNo: "INV/26-27/000101" }, visit: { ...PRICED.visit, feeStatus: "settled" } } : PRICED),
      // The request ARRIVES and the bill is made — but the answer is lost on the way back.
      routes: { "POST /billing/invoices": () => { billed = true; return "offline"; } },
    });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    await fireEvent.press(await screen.findByTestId("settle"));
    expect(await screen.findByTestId("counter-error")).toHaveTextContent(/NOT known whether the bill was made/);
    expect(screen.getByTestId("settle")).toHaveTextContent("Check and try again");
    expect(screen.queryByTestId("issued")).toBeNull();
    await fireEvent.press(screen.getByTestId("settle"));
    expect(await screen.findByTestId("issued")).toHaveTextContent(/INV\/26-27\/000101/);
    expect(s.of("POST /billing/invoices")).toHaveLength(1);
  });

  it("…and when the first request never arrived, the retry re-sends the SAME key and the same bill", async () => {
    let n = 0;
    const s = world({
      routes: { "POST /billing/invoices": () => (++n === 1 ? "offline" : { status: 201, body: { invoiceId: "i1", invoiceNo: "INV/26-27/000101", receiptNo: "RCT/1", totals: { netPayablePaise: 30000 } } }) },
    });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    await fireEvent.press(await screen.findByTestId("settle"));
    await screen.findByTestId("counter-error");
    await fireEvent.press(screen.getByTestId("settle"));
    await screen.findByTestId("issued");
    const [first, second] = s.of("POST /billing/invoices");
    expect(second?.idem).toBe(first?.idem);
    expect(second?.body).toEqual(first?.body);
  });

  it("NEVER a second visit: a lost answer keeps the choice locked and the retry carries the same key", async () => {
    let n = 0;
    const s = world({ quote: () => FREE, routes: { "POST /opd/walk-in": () => (++n === 1 ? "offline" : { status: 201, body: WALKIN }) } });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    expect(await screen.findByTestId("counter-error")).toHaveTextContent(/NOT known whether the visit was opened/);
    expect(screen.getByTestId("seat-go")).toHaveTextContent("Check and try again");
    // The choice cannot be changed while the answer is unknown — a second doctor would be a second visit.
    await fireEvent.press(screen.getByTestId("doctor-d1"));
    await fireEvent.press(screen.getByTestId("seat-go"));
    expect(await screen.findByTestId("token-no")).toHaveTextContent("MED-7");
    const [first, second] = s.of("POST /opd/walk-in");
    expect(second?.idem).toBe(first?.idem);
    expect(second?.body).toEqual(first?.body);
    expect((second?.body as { doctorId: string }).doctorId).toBe("d2");
  });

  it("bill-first lane: no token until the money is in, then the position is taken once", async () => {
    const s = world({
      flow: { counterSequence: "bill_first", tokenLane: "token_on_payment" },
      quote: () => ({ ...PRICED, visit: { ...PRICED.visit, tokenNo: null } }),
      routes: {
        "POST /opd/walk-in": () => ({ status: 201, body: { ...WALKIN, tokenNo: null, sessionId: null } }),
        "POST /billing/invoices": () => ({ status: 201, body: { invoiceId: "i1", invoiceNo: "INV/1", receiptNo: "RCT/1", totals: { netPayablePaise: 30000 } } }),
        "POST /opd/visits/e1/join-queue": () => ({ status: 200, body: { tokenNo: 9, alreadyJoined: false } }),
      },
    });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    expect((s.of("POST /opd/walk-in")[0]?.body as { join: string }).join).toBe("defer");
    expect(await screen.findByTestId("token-held")).toHaveTextContent(/No token yet/);
    expect(s.of("POST /opd/visits/e1/join-queue")).toHaveLength(0);
    await fireEvent.press(await screen.findByTestId("settle"));
    expect(await screen.findByTestId("token-no")).toHaveTextContent("MED-9");
    expect(s.of("POST /opd/visits/e1/join-queue")).toHaveLength(1);
  });

  it("registers with the short form: gaps are named, a child needs a guardian, and the record is read back", async () => {
    const s = world({
      routes: {
        "GET /patients/search": () => ({ status: 200, body: { items: [] } }),
        "POST /patients": () => ({ status: 201, body: { patient: { id: "p9", uhid: "U00110099", name: "Ravi", dob: "2018-10-06T00:00:00.000Z", phone: null, addressLine: null } } }),
        "GET /patients/p9": () => ({ status: 200, body: { patient: { uhid: "U00110099", name: "Ravi", alias: null, dob: "2018-10-06T00:00:00.000Z", phone: null, addressLine: null, administrativeGender: "male" } } }),
        "GET /patients/p9/linked": () => ({ status: 200, body: { numbers: [], total: 0, items: [] } }),
        "GET /opd/patients/p9/timeline": () => ({ status: 200, body: { items: [] } }),
      },
    });
    await mount(s.fetcher);
    await fireEvent.changeText(screen.getByTestId("counter-query"), "Ravi");
    await fireEvent.press(screen.getByTestId("counter-find"));
    expect(await screen.findByTestId("counter-nohits")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("counter-new"));
    expect(screen.getByTestId("reg-name").props.value).toBe("Ravi");
    await fireEvent.press(screen.getByTestId("reg-submit"));
    expect(s.of("POST /patients")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("reg-sex-male"));
    await fireEvent.changeText(screen.getByTestId("reg-age"), "8");
    // Eight years old: the guardian block appears, and the form will not be sent into the server's refusal.
    expect(await screen.findByTestId("reg-guardian")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("reg-submit"));
    expect(s.of("POST /patients")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("reg-guardian-name"), "Mohan Kumar");
    await fireEvent.press(screen.getByTestId("reg-rel-father"));
    await fireEvent.press(screen.getByTestId("reg-submit"));
    await waitFor(() => expect(screen.getByTestId("counter-person")).toHaveTextContent(/U00110099/));
    expect(s.of("POST /patients")[0]?.body).toEqual({
      name: "Ravi", sex: "male", ageYears: 8,
      guardian: { name: "Mohan Kumar", relationship: "father", authorityMessages: true, authorityBills: true, authorityConsents: false, authorityDsr: false },
    });
  });

  it("the server's duplicate warning is a list to judge: 'this is them' takes the existing record, and registering anyway is a second, explicit tap", async () => {
    let n = 0;
    const s = world({
      routes: {
        "POST /patients": (b) => {
          n++;
          if ((b as { acknowledgedDuplicates?: boolean }).acknowledgedDuplicates !== true) {
            return { status: 409, body: { statusCode: 409, code: "duplicate_suspected", message: "a close match exists", detail: { candidates: [HIT] } } };
          }
          return { status: 201, body: { patient: { id: "p9", uhid: "U00110099", name: "Geeta Devi", dob: null, phone: "9876543210", addressLine: null } } };
        },
        "GET /patients/p9": () => ({ status: 404, body: { message: "patient_not_found" } }),
        "GET /patients/p9/linked": () => ({ status: 200, body: { numbers: [], total: 0, items: [] } }),
        "GET /opd/patients/p9/timeline": () => ({ status: 200, body: { items: [] } }),
      },
    });
    await mount(s.fetcher);
    await fireEvent.press(screen.getByTestId("counter-new"));
    await fireEvent.changeText(screen.getByTestId("reg-name"), "Geeta Devi");
    await fireEvent.press(screen.getByTestId("reg-sex-female"));
    await fireEvent.changeText(screen.getByTestId("reg-age"), "42");
    await fireEvent.changeText(screen.getByTestId("reg-phone"), "9876543210");
    await fireEvent.press(screen.getByTestId("reg-submit"));
    expect(await screen.findByTestId("dup-p1")).toHaveTextContent(/Geeta Devi/);
    expect(n).toBe(1);
    await fireEvent.press(screen.getByTestId("reg-anyway"));
    await waitFor(() => expect(screen.getByTestId("counter-person")).toHaveTextContent(/U00110099/));
    expect((s.of("POST /patients")[1]?.body as { acknowledgedDuplicates?: boolean }).acknowledgedDuplicates).toBe(true);
  });

  it("a scanned patient card is trusted only after the server verifies it", async () => {
    const s = world({ routes: {
      "POST /patients/qr/verify": (b) => ((b as { payload: string }).payload === "q1.good"
        ? { status: 200, body: { ok: true, patient: { id: "p1", uhid: "U00110049", name: "Geeta Devi", administrativeGender: "female", dob: "1984-03-14T00:00:00.000Z" } } }
        : { status: 200, body: { ok: false, reason: "invalid_signature" } }),
    } });
    await mount(s.fetcher);
    await fireEvent.press(screen.getByTestId("counter-scan"));
    await waitFor(() => expect(scanned).not.toBeNull());
    await act(async () => { scanned!("q1.forged"); });
    expect(await screen.findByTestId("counter-error")).toHaveTextContent(/could not be verified/);
    expect(screen.queryByTestId("counter-person")).toBeNull();
    await fireEvent.press(screen.getByTestId("counter-scan"));
    await waitFor(() => expect(scanned).not.toBeNull());
    await act(async () => { scanned!("q1.good"); });
    await waitFor(() => expect(screen.getByTestId("counter-person")).toHaveTextContent(/Geeta Devi/));
  });

  it("today's open visit is offered instead of a second one, and opening it bills what it already carries", async () => {
    const s = world({ routes: {
      "GET /opd/patients/p1/timeline": () => ({ status: 200, body: { items: [
        // TODAY, from the same IST clock the screen reads: a fixed date here turned main red at IST midnight.
        { encounterId: "e1", visitNo: "V2610060007", serviceDate: todayIst(), status: "registered", visitType: "new", doctorId: "d2", doctorName: "Dr. Nitish Kumar Jha", departmentId: "med", departmentName: "General Medicine" },
      ] } }),
    } });
    await mount(s.fetcher);
    await findAndHold();
    expect(await screen.findByTestId("open-e1")).toHaveTextContent(/General Medicine · Dr\. Nitish Kumar Jha/);
    expect(screen.getByTestId("person-seat")).toHaveTextContent("Open another visit");
    await fireEvent.press(screen.getByTestId("adopt-e1"));
    expect(await screen.findByTestId("token-no")).toHaveTextContent("MED-7");
    expect(s.of("POST /opd/walk-in")).toHaveLength(0);
    expect(await screen.findByTestId("bill-total")).toHaveTextContent("₹300");
  });

  it("wrong department: the cost is shown before the write, a reason is required, and the desk then holds the new visit", async () => {
    const s = world({ quote: () => FREE, routes: {
      "GET /opd/visits/e1/move-preview": () => ({ status: 200, body: {
        encounterId: "e1", from: { departmentId: "med", doctorId: "d2", visitType: "new", feePaise: 30000 }, to: { departmentId: "ort", visitType: "new", feePaise: 30000 },
        standingInvoiceNo: "INV/1", maySettleDifference: true,
        money: { kind: "transfer", invoiceId: "i1", invoiceNo: "INV/1", paidPaise: 30000, newFeePaise: 30000, differencePaise: 0, billingOfficeReason: null },
      } }),
      "POST /opd/visits/e1/move-department": () => ({ status: 200, body: {
        from: { encounter: { id: "e1", visitNo: "V2610060007" }, tokenNo: 7 },
        to: { encounter: { id: "e2", visitNo: "V2610060008", patientId: "p1", departmentId: "ort", doctorId: "d3" }, tokenNo: 3, visitType: "new" },
      } }),
      "GET /billing/visits/e2/fee-quote": () => ({ status: 200, body: { ...FREE, encounterId: "e2", visit: { ...FREE.visit, visitNo: "V2610060008", tokenNo: 3, departmentCode: "ORT" } } }),
    } });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    await fireEvent.press(await screen.findByTestId("move-open"));
    expect(await screen.findByTestId("move-dept-from")).toHaveTextContent(/General Medicine/);
    expect(screen.getByTestId("move-dept-from")).toHaveTextContent(/MED-7/);
    await fireEvent.press(screen.getByTestId("move-dept-ort"));
    expect(await screen.findByTestId("move-dept-fee-after")).toHaveTextContent("New · ₹300");
    expect(screen.getByTestId("move-dept-money")).toHaveTextContent(/₹300 paid on bill INV\/1 moves to the new visit/);
    await fireEvent.press(screen.getByTestId("move-dept-submit"));
    expect(await screen.findByTestId("move-dept-error")).toHaveTextContent(/Write why/);
    expect(s.of("POST /opd/visits/e1/move-department")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("move-dept-reason"), "booked in Medicine by mistake");
    await fireEvent.press(screen.getByTestId("move-dept-submit"));
    expect(await screen.findByTestId("counter-flash")).toHaveTextContent(/Moved to Orthopaedics — new token ORT-3/);
    expect(s.of("POST /opd/visits/e1/move-department")[0]?.body).toEqual({ departmentId: "ort", doctorId: "d3", reason: "booked in Medicine by mistake" });
    expect(screen.getByTestId("token-no")).toHaveTextContent("ORT-3");
    expect(screen.getByTestId("visit-no")).toHaveTextContent("V2610060008");
  });

  it("a fee difference this desk may not settle stops the move, and nothing is sent", async () => {
    const s = world({ quote: () => FREE, routes: {
      "GET /opd/visits/e1/move-preview": () => ({ status: 200, body: {
        encounterId: "e1", from: { departmentId: "med", doctorId: "d2", visitType: "renewal", feePaise: 15000 }, to: { departmentId: "ort", visitType: "new", feePaise: 30000 },
        standingInvoiceNo: "INV/1", maySettleDifference: false,
        money: { kind: "difference", invoiceId: "i1", invoiceNo: "INV/1", paidPaise: 15000, newFeePaise: 30000, differencePaise: 15000, billingOfficeReason: null },
      } }),
    } });
    await mount(s.fetcher);
    await findAndHold();
    await seatWith();
    await fireEvent.press(await screen.findByTestId("move-open"));
    await fireEvent.press(await screen.findByTestId("move-dept-ort"));
    expect(await screen.findByTestId("move-dept-money")).toHaveTextContent(/the billing counter makes this move/);
    expect(screen.queryByTestId("move-dept-tender")).toBeNull();
    expect(screen.getByTestId("move-dept-submit").props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("the visit card: the paper it printed, print again as a new job, its bills — and no desk move once the doctor has seen the patient", async () => {
    const s = world({ routes: {
      "GET /billing/invoices": () => ({ status: 200, body: { items: [{ id: "i0", invoiceNo: "INV/26-27/000050", netPayablePaise: 30000, issuedAt: "2026-09-20T05:00:00Z", creditExtended: false }] } }),
      "POST /print/reprint": () => ({ status: 200, body: { id: "j2" } }),
    } });
    await mount(s.fetcher);
    await findAndHold();
    await fireEvent.press(await screen.findByTestId("visit-e0"));
    expect(await screen.findByTestId("visit-card-no")).toHaveTextContent("V2609200003");
    expect(screen.getByTestId("visit-card-status")).toHaveTextContent("seen");
    expect(await screen.findByTestId("paper-opd_token_slip")).toHaveTextContent(/token slip/);
    expect(await screen.findByTestId("visit-card-bills")).toHaveTextContent(/INV\/26-27\/000050/);
    expect(screen.queryByTestId("visit-card-move")).toBeNull();
    await fireEvent.press(screen.getByTestId("reprint-opd_token_slip"));
    expect(await screen.findByTestId("visit-card-said")).toHaveTextContent(/token slip was sent to the printer again/);
    expect(s.of("POST /print/reprint")[0]?.body).toEqual({ jobId: "j1" });
  });

  it("says it in Hindi", async () => {
    const s = world({ quote: () => FREE });
    await mount(s.fetcher, "hi");
    expect(screen.getByTestId("counter-step")).toHaveTextContent("खोजें");
    await findAndHold();
    expect(screen.getByTestId("person-seat")).toHaveTextContent("विज़िट खोलें");
    await seatWith();
    expect(await screen.findByTestId("bill-free")).toHaveTextContent("₹0 (समाज सेवा छूट)");
    expect(screen.getByTestId("token-stamp")).toHaveTextContent("निःशुल्क");
  });
});
