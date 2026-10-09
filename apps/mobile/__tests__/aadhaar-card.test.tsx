import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
import { NOW, me, mount, server } from "../testing/attendance";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "a.kumar", since: "2026-10-14T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const STAFF = ["roster.read"];
const OWES = { aadhaarConfigured: true, aadhaar: null, attendance: "not_linked", needsAadhaar: true };
const DONE = { aadhaarConfigured: true, aadhaar: "XXXX XXXX 0124", attendance: "linked", needsAadhaar: false };
const NOT_LINKED = { status: 200, body: { linked: false, reason: "no_match", configured: true, leadsTeam: false } };

/**
 * "ADD YOUR AADHAAR" on the phone (owner 2026-10-09): a card at the top of the home while the server
 * says `needsAadhaar`; a sheet with one numeric box; gone after the save, with one line saying what
 * happened. The number travels in the POST and nowhere else.
 */
describe("the home's Aadhaar card", () => {
  let clock: jest.SpyInstance;
  beforeEach(() => { _forgetHomeForTests(); clock = jest.spyOn(Date, "now").mockReturnValue(NOW); });
  afterEach(() => { clock.mockRestore(); });

  it("is drawn only while the server says needsAadhaar", async () => {
    const s = server(STAFF, { "GET /me/identity": { status: 200, body: { ...OWES, needsAadhaar: false } }, "GET /attendance/me": { status: 200, body: me() } });
    await mount(s.fetcher, <SeatHome />);
    await screen.findByTestId("attendance-card");
    await waitFor(() => expect(s.sent("GET /me/identity")).toHaveLength(1));
    expect(screen.queryByTestId("aadhaar-card")).toBeNull();
  });

  it("an older server (404) draws no card and no error", async () => {
    const s = server(STAFF, { "GET /attendance/me": NOT_LINKED });
    await mount(s.fetcher, <SeatHome />);
    await screen.findByTestId("attendance-not-linked");
    expect(screen.queryByTestId("aadhaar-card")).toBeNull();
  });

  it("shows while owed; Save waits for twelve digits; a LINKED save removes the card and says 'Attendance linked'", async () => {
    let saved = false;
    const s = server(STAFF, {
      "GET /me/identity": () => ({ status: 200, body: saved ? DONE : OWES }),
      "POST /me/identity": () => { saved = true; return { status: 200, body: DONE }; },
      "GET /attendance/me": () => (saved ? { status: 200, body: me() } : NOT_LINKED),
    });
    await mount(s.fetcher, <SeatHome />);
    const card = await screen.findByTestId("aadhaar-card");
    expect(card).toHaveTextContent(/Add your Aadhaar to see attendance/);
    await fireEvent.press(card);
    const input = await screen.findByTestId("aadhaar-input");
    expect(input.props.keyboardType).toBe("number-pad");
    expect(input.props.autoComplete).toBe("off");
    await fireEvent.changeText(input, "2345 6789 012");
    expect(screen.getByTestId("aadhaar-save")).toBeDisabled();
    await fireEvent.changeText(input, "2345 6789 0124");
    await fireEvent.press(screen.getByTestId("aadhaar-save"));

    await waitFor(() => expect(s.sent("POST /me/identity").map((c) => c.body)).toEqual([{ aadhaar: "2345 6789 0124" }]));
    expect(await screen.findByTestId("home-said")).toHaveTextContent("Attendance linked");
    expect(screen.queryByTestId("aadhaar-card")).toBeNull();
    expect(screen.queryByTestId("aadhaar-sheet")).toBeNull();
    // The person's attendance is read again at once: they may be linked now.
    expect(await screen.findByTestId("attendance-card")).toBeTruthy();
    // The digits went in the one POST, and in no other request.
    expect(s.calls.filter((c) => c.key !== "POST /me/identity" && JSON.stringify(c).includes("2345"))).toEqual([]);
  });

  it("a number the machine does not hold yet: 'Saved · attendance team will match', and the card is gone", async () => {
    const s = server(STAFF, {
      "GET /me/identity": { status: 200, body: OWES },
      "POST /me/identity": { status: 200, body: { ...OWES, aadhaar: "XXXX XXXX 0124", needsAadhaar: false } },
      "GET /attendance/me": NOT_LINKED,
    });
    await mount(s.fetcher, <SeatHome />);
    await fireEvent.press(await screen.findByTestId("aadhaar-card"));
    await fireEvent.changeText(await screen.findByTestId("aadhaar-input"), "234567890124");
    await fireEvent.press(screen.getByTestId("aadhaar-save"));
    expect(await screen.findByTestId("home-said")).toHaveTextContent("Saved · attendance team will match");
    expect(screen.queryByTestId("aadhaar-card")).toBeNull();
  });

  it("a refusal is a fixed line in the sheet; the box keeps the number to correct; the card stays", async () => {
    const s = server(STAFF, {
      "GET /me/identity": { status: 200, body: OWES },
      "POST /me/identity": { status: 400, body: { code: "aadhaar_invalid", problem: "bad_check_digit" } },
      "GET /attendance/me": NOT_LINKED,
    });
    await mount(s.fetcher, <SeatHome />);
    await fireEvent.press(await screen.findByTestId("aadhaar-card"));
    await fireEvent.changeText(await screen.findByTestId("aadhaar-input"), "234567890125");
    await fireEvent.press(screen.getByTestId("aadhaar-save"));
    expect(await screen.findByTestId("aadhaar-error")).toHaveTextContent("Not a valid Aadhaar");
    expect(screen.getByTestId("aadhaar-input").props.value).toBe("234567890125");
    await fireEvent.press(screen.getByTestId("aadhaar-cancel"));
    expect(screen.getByTestId("aadhaar-card")).toBeTruthy();
  });

  it("in Hindi the card speaks Hindi", async () => {
    const s = server(STAFF, { "GET /me/identity": { status: 200, body: OWES }, "GET /attendance/me": NOT_LINKED });
    await mount(s.fetcher, <SeatHome />, "hi");
    expect(await screen.findByTestId("aadhaar-card")).toHaveTextContent(/आधार जोड़ें/);
  });
});
