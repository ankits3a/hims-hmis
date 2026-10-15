import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { RosterOnNow } from "../src/screens/roster-on-now";
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
// Tuesday 6 Oct 2026, 11:30 IST. Take 08:00 Tue → 08:00 Wed.
const AT = "2026-10-06T06:00:00.000Z";
const TAKE = { startsAt: "2026-10-06T02:30:00.000Z", endsAt: "2026-10-07T02:30:00.000Z" };

const med = (over: Record<string, unknown> = {}) => ({
  departmentId: "d-med", code: "MED", name: "General Medicine", units: 5, source: "published", skeleton: false,
  unitOnTake: { teamId: "t3", code: "MED-U3", name: "General Medicine Unit III", ...TAKE },
  backupUnit: { teamId: "t2", code: "MED-U2", name: "General Medicine Unit II", ...TAKE },
  inTheBuilding: [
    { userId: "u-sr", name: "Dr. Kavya Nair", positionKey: "unit_sr", positionLabel: "Unit SR", cadre: "senior_resident", phone: "9876500011" },
    { userId: "u-jr", name: "Dr. Imran Ali", positionKey: "ward_jr", positionLabel: "Ward JR", cadre: "junior_resident", phone: null },
  ],
  facultyOnCall: [{ userId: "u-f", name: "Dr. Chandan Kumar", positionKey: "faculty_on_call", positionLabel: "Faculty", callTier: 1 }, { userId: null, name: null, positionKey: "faculty_on_call", positionLabel: "Faculty", callTier: 2 }],
  ...over,
});
const ent = (over: Record<string, unknown> = {}) => ({
  departmentId: "d-ent", code: "ENT", name: "ENT", units: 1, source: "static", skeleton: false,
  unitOnTake: { teamId: "e1", code: "ENT-U1", name: "ENT Unit I", ...TAKE }, backupUnit: null, inTheBuilding: [], facultyOnCall: [],
  inOpd: [{ userId: "u-o1", name: "Dr. Kishore Kunal", designation: "Asst. Prof", from: "2026-10-06T03:30:00.000Z", till: "2026-10-06T10:30:00.000Z", now: true }],
  ...over,
});
const board = (over: Record<string, unknown> = {}) => ({
  at: AT, resolverEnabled: true, you: { name: "Asha Devi", grade: null, positionKey: null, unitName: null, departmentName: null },
  departments: [med(), ent()],
  services: [
    { positionKey: "duty_manager", positionLabel: "Duty manager", cadre: "admin", source: "published", people: [{ userId: "u-dm", name: "Mr. Rakesh Sinha", departmentId: null }] },
    { positionKey: "anaesthetist_on_call", positionLabel: "Anaesthetist on call", cadre: "faculty", source: "published", people: [] },
  ],
  holes: [{ kind: "vacant_slot", departmentId: "d-med", departmentName: "General Medicine", from: "2026-10-06T14:30:00.000Z", to: "2026-10-07T02:30:00.000Z", positionKey: "ward_jr", positionLabel: "Ward JR", userId: null, name: null, count: null }],
  departmentsWithoutUnit: [{ departmentId: "d-ped", code: "PED", name: "Paediatrics", doctors: 1, inOpd: [{ userId: "u-o2", name: "Dr. S. I. Raza", designation: "Guest Faculty", from: "2026-10-06T08:30:00.000Z", till: "2026-10-06T11:30:00.000Z", now: false }] }],
  flags: [],
  ...over,
});

function world(b: unknown = board(), extra: Record<string, Route> = {}) {
  const state = { b };
  const s = server({
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /roster/on-now": () => ({ status: 200, body: state.b }),
    ...extra,
  });
  return { ...s, state };
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <RosterOnNow /> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

describe("who is on now, on a phone", () => {
  it("reads the board: the clock in IST and what it means for the take, the unit and till when, who is in, faculty, the overflow", async () => {
    const w = world();
    await mount(w.fetcher);
    expect(await screen.findByTestId("dept-MED")).toHaveTextContent(/General Medicine/);
    expect(screen.getByTestId("on-now-clock")).toHaveTextContent("Tuesday 6 October, 11:30");
    expect(screen.getByTestId("on-now-note")).toHaveTextContent("Tuesday's units took over at 08:00. Last night's residents are resting and cannot be called.");
    const row = screen.getByTestId("dept-MED");
    expect(row).toHaveTextContent(/Unit III/);
    // The handover is tomorrow, so the weekday is named: nobody reads "till 08:00" as this morning's.
    expect(screen.getByTestId("till-MED")).toHaveTextContent("Tuesday's take · till Wed 08:00");
    expect(row).toHaveTextContent(/SR.*Dr\. Kavya Nair/);
    expect(row).toHaveTextContent(/JR.*Dr\. Imran Ali/);
    expect(row).toHaveTextContent(/Dr\. Chandan Kumar/);
    expect(row).toHaveTextContent(/Vacant/);
    expect(row).toHaveTextContent(/in the hospital/);
    expect(row).toHaveTextContent(/Unit II is the backup unit/);
    // The server's now is asked for — no `at` of the phone's own.
    expect(w.of("GET /roster/on-now")[0]!.url).not.toContain("at=");
  });

  it("D6: a CALL button only where the server sent a number — and it dials that number", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const w = world();
    await mount(w.fetcher);
    await screen.findByTestId("dept-MED");
    expect(screen.queryByTestId("call-u-jr")).toBeNull();
    await fireEvent.press(screen.getByTestId("call-u-sr"));
    expect(open).toHaveBeenCalledWith("tel:9876500011");
    open.mockRestore();
  });

  it("where no duty roster is published the row shows who is sitting in OPD, with one quiet line — and a department with no unit is a quiet card, never a hole", async () => {
    const w = world();
    await mount(w.fetcher);
    const row = await screen.findByTestId("in-opd-ENT");
    expect(row).toHaveTextContent(/Dr\. Kishore Kunal/);
    expect(row).toHaveTextContent(/Asst\. Prof · in OPD till 16:00/);
    expect(screen.getByTestId("till-ENT")).toHaveTextContent("one unit · every day");
    expect(screen.getByTestId("dept-ENT")).toHaveTextContent(/General Medicine's unit on take covers/);
    expect(screen.getByTestId("on-now-opd-fallback")).toHaveTextContent("Where no duty roster is published, the board shows who is sitting in OPD.");
    const ped = screen.getByTestId("dept-nounit-PED");
    expect(ped).toHaveTextContent(/No unit · OPD only/);
    expect(ped).toHaveTextContent(/Dr\. S\. I\. Raza/);
    expect(ped).toHaveTextContent(/Guest Faculty · in OPD from 14:00/);
  });

  it("a department with neither a roster nor an OPD list SAYS SO — an empty card would look staffed", async () => {
    const w = world(board({
      departments: [med({ source: "static", inTheBuilding: [], facultyOnCall: [], unitOnTake: null, backupUnit: null })],
      holes: [{ kind: "no_take_cycle", departmentId: "d-med", departmentName: "General Medicine", from: AT, to: AT, positionKey: null, positionLabel: null, userId: null, name: null, count: null }],
    }));
    await mount(w.fetcher);
    expect(await screen.findByTestId("no-unit-MED")).toHaveTextContent("No take cycle");
    expect(screen.getByTestId("unpublished-MED")).toHaveTextContent(/General Medicine has no take cycle, so no unit is named as admitting and nobody is listed/);
  });

  it("lists the services and the holes in the board's own sentences", async () => {
    const w = world();
    await mount(w.fetcher);
    expect(await screen.findByTestId("service-duty_manager")).toHaveTextContent(/Duty manager.*Mr\. Rakesh Sinha/);
    expect(screen.getByTestId("service-anaesthetist_on_call")).toHaveTextContent(/Nobody is on/);
    expect(screen.getByTestId("hole-0")).toHaveTextContent(/Tue 6 Oct, 20:00/);
    expect(screen.getByTestId("hole-0")).toHaveTextContent(/General Medicine: Ward junior resident from 20:00 to 08:00 has nobody named\./);
    expect(screen.queryByTestId("no-holes")).toBeNull();
  });

  it("with nothing wrong the holes card says so", async () => {
    const w = world(board({ holes: [] }));
    await mount(w.fetcher);
    expect(await screen.findByTestId("no-holes")).toHaveTextContent(/No holes: every take is covered/);
  });

  it("'In 8 hours' asks the server for that instant", async () => {
    const w = world();
    await mount(w.fetcher);
    await screen.findByTestId("dept-MED");
    const before = Date.now();
    await fireEvent.press(screen.getByTestId("when-ahead"));
    await waitFor(() => expect(w.of("GET /roster/on-now").some((c) => c.url.includes("at="))).toBe(true));
    const at = decodeURIComponent(/at=([^&]+)/.exec(w.of("GET /roster/on-now").find((c) => c.url.includes("at="))!.url)![1]!);
    expect(Date.parse(at) - before).toBeGreaterThan(7.9 * 3_600_000);
    expect(Date.parse(at) - before).toBeLessThan(8.1 * 3_600_000);
    // A flag is about the board NOW: not offered on a board eight hours ahead.
    await screen.findByTestId("dept-MED");
    expect(screen.queryByTestId("wrong-open")).toBeNull();
  });

  it("'This is wrong' sends one flag — the department, the name, the board's instant, the line — and says the duty manager has it", async () => {
    const w = world(board(), { "POST /roster/flags": () => ({ status: 201, body: { flagId: "f1" } }) });
    await mount(w.fetcher);
    await screen.findByTestId("dept-MED");
    await fireEvent.press(screen.getByTestId("wrong-open"));
    // Only a PUBLISHED row can be flagged; the first name on it is picked.
    expect(screen.queryByTestId("wrong-dept-ENT")).toBeNull();
    await fireEvent.press(screen.getByTestId("wrong-who-u-jr"));
    await fireEvent.changeText(screen.getByTestId("wrong-note"), "  on leave since yesterday  ");
    await fireEvent.press(screen.getByTestId("wrong-send"));
    expect(await screen.findByTestId("on-now-flash")).toHaveTextContent("Flagged — the duty manager sees it on the board.");
    expect(w.of("POST /roster/flags")).toHaveLength(1);
    expect(w.of("POST /roster/flags")[0]!.body).toEqual({ departmentId: "d-med", userId: "u-jr", at: AT, note: "on leave since yesterday" });
    expect(screen.queryByTestId("wrong-sheet")).toBeNull();
  });

  it("a flag with no signal is NOT queued: the sheet stays, says nothing was changed, and the line is still typed", async () => {
    const w = world(board(), { "POST /roster/flags": () => "offline" });
    await mount(w.fetcher);
    await screen.findByTestId("dept-MED");
    await fireEvent.press(screen.getByTestId("wrong-open"));
    await fireEvent.changeText(screen.getByTestId("wrong-note"), "wrong name");
    await fireEvent.press(screen.getByTestId("wrong-send"));
    expect(await screen.findByTestId("wrong-error")).toHaveTextContent("The server could not be reached. Nothing was changed.");
    expect(screen.getByTestId("wrong-note").props.value).toBe("wrong name");
    expect(screen.queryByTestId("on-now-flash")).toBeNull();
    expect(w.of("POST /roster/flags")).toHaveLength(1);
  });

  it("an open flag is on the holes card; only somebody who may deal with it gets the button, and a refusal is the server's code in a sentence", async () => {
    const flag = (id: string, youMayResolve: boolean) => ({ flagId: id, departmentId: "d-med", user: { userId: "u-jr", name: "Dr. Imran Ali" }, at: AT, note: "on leave", raisedBy: { userId: "u-x", name: "Sr. Kavita" }, raisedAt: "2026-10-06T05:00:00.000Z", youMayResolve });
    const w = world(board({ flags: [flag("f1", true), flag("f2", false)] }), {
      "POST /roster/flags/f1/resolve": () => ({ status: 409, body: { statusCode: 409, message: "x", code: "flag_already_resolved" } }),
    });
    await mount(w.fetcher);
    expect(await screen.findByTestId("flag-f1")).toHaveTextContent(/Tue 6 Oct, 10:30 · flagged by Sr\. Kavita/);
    expect(screen.getByTestId("flag-f1")).toHaveTextContent(/General Medicine: Dr\. Imran Ali is on the board, and that is wrong — “on leave”/);
    expect(screen.queryByTestId("flag-dealt-f2")).toBeNull();
    await fireEvent.press(screen.getByTestId("flag-dealt-f1"));
    expect(await screen.findByTestId("on-now-error")).toHaveTextContent("Somebody has already dealt with this.");
  });

  it("a login that may not read the roster is told so in the board's own words", async () => {
    const w = world(board(), { "GET /roster/on-now": () => ({ status: 403, body: { statusCode: 403, message: "Forbidden" } }) });
    await mount(w.fetcher);
    expect(await screen.findByTestId("on-now-refusal")).toHaveTextContent(/You do not hold roster\.read/);
    expect(screen.queryByTestId("dept-MED")).toBeNull();
  });

  it("with no signal at all it says so and offers to try again; it never draws an empty board", async () => {
    let up = false;
    const w = world(board(), { "GET /roster/on-now": () => (up ? { status: 200, body: board() } : "offline") });
    await mount(w.fetcher);
    expect(await screen.findByTestId("on-now-offline")).toHaveTextContent(/could not be read/);
    expect(screen.queryByTestId("on-now-holes")).toBeNull();
    up = true;
    await fireEvent.press(screen.getByTestId("on-now-retry"));
    expect(await screen.findByTestId("dept-MED")).toBeTruthy();
    expect(screen.queryByTestId("on-now-offline")).toBeNull();
  });

  it("reads in Hindi with the web's own sentences", async () => {
    const w = world();
    await mount(w.fetcher, "hi");
    expect(await screen.findByTestId("on-now-clock")).toHaveTextContent("मंगलवार 6 अक्टूबर, 11:30");
    expect(screen.getByTestId("till-ENT")).toHaveTextContent(require("../src/locales/hi.json").rosterOnNow.singleUnit);
    expect(screen.getByTestId("wrong-open")).toHaveTextContent("यह गलत है");
  });
});
