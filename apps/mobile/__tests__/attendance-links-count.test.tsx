import { screen, waitFor } from "@testing-library/react-native";
import webEn from "../../web/src/locales/en.json";
import webHi from "../../web/src/locales/hi.json";
import { attendanceApi } from "../src/attendance/api";
import { LINK_WORDS } from "../src/attendance/links";
import { AttendanceManage } from "../src/screens/attendance-manage";
import { mount, server, type Route } from "../testing/attendance";

/**
 * #928 (follow-up to #634) — THE LINK COUNT ON THE PHONE'S MANAGE SCREEN. The same numbers as the web's
 * `/attendance/links`, from `GET /attendance/links`, for holders of `attendance.all.read`: linked of
 * active, not linked, need a person, logins linked. Numbers only — never a name, a mobile or an Aadhaar.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "committee.one" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }), useLocalSearchParams: () => ({}) }));

const ALL = ["attendance.all.read"];
const COUNTS = { active: 1240, linked: 1093, unlinked: 147, needsAttention: 3, loginsActive: 1302, loginsLinked: 1088 };
/** The server's whole reply: the count AND the first page of unlinked people, with names — which the phone must not draw. */
const LINKS = {
  counts: COUNTS, total: 147, offset: 0,
  people: [
    { pin: "411", name: "Sunita Devi", dept: "Housekeeping", post: "Attendant", reason: "no_match" },
    { pin: "412", name: "Ravi Ranjan", dept: "Security", post: "Guard", reason: "two_matches" },
  ],
};
const TODAY = { date: "2026-10-14", configured: true, people: [], summary: { total: 0, byStatus: {}, byDept: [] } };
const routes = (links: Route = { status: 200, body: LINKS }): Record<string, Route> => ({ "GET /attendance/today": { status: 200, body: TODAY }, "GET /attendance/links": links });

describe("#928 — the link count on the phone's manage screen", () => {
  it("the committee's Today opens with the server's numbers — the same four the web shows", async () => {
    const s = server(ALL, routes());
    await mount(s.fetcher, <AttendanceManage />);
    await screen.findByTestId("att-links");
    expect(screen.getByTestId("att-links-linked")).toHaveTextContent("1,093 of 1,240 linked");
    expect(screen.getByTestId("att-links-pct")).toHaveTextContent("88%");
    expect(screen.getByTestId("att-links-unlinked")).toHaveTextContent("Not linked: 147");
    expect(screen.getByTestId("att-links-attention")).toHaveTextContent("Need a person: 3");
    expect(screen.getByTestId("att-links-logins")).toHaveTextContent("Logins linked: 1,088 of 1,302");
    expect(s.sent("GET /attendance/links")).toHaveLength(1);
  });

  it("draws no name, mobile or Aadhaar — the names in the server's reply never reach the screen", async () => {
    const s = server(ALL, routes());
    await mount(s.fetcher, <AttendanceManage />);
    const card = await screen.findByTestId("att-links");
    await screen.findByTestId("att-today-list");
    expect(screen.queryByText(/Sunita Devi|Ravi Ranjan/)).toBeNull();
    // Six digits in a row is where a mobile or an Aadhaar would show (the server's own rule, links.controller.ts).
    expect(card).not.toHaveTextContent(/\d(?:[\s-]?\d){5,}/);
    await expect(attendanceApi(async <T,>() => LINKS as T).linkCounts()).resolves.toEqual(COUNTS);
  });

  it("in Hindi, the web's Hindi sentences", async () => {
    const s = server(ALL, routes());
    await mount(s.fetcher, <AttendanceManage />, "hi");
    await screen.findByTestId("att-links");
    expect(screen.getByTestId("att-links-linked")).toHaveTextContent("1,240 में से 1,093 लिंक");
    expect(screen.getByTestId("att-links-unlinked")).toHaveTextContent("लिंक नहीं: 147");
    expect(screen.getByTestId("att-links-attention")).toHaveTextContent("व्यक्ति चाहिए: 3");
  });

  it("an empty machine list reads 0%, not a division by nothing", async () => {
    const s = server(ALL, routes({ status: 200, body: { ...LINKS, counts: { active: 0, linked: 0, unlinked: 0, needsAttention: 0, loginsActive: 12, loginsLinked: 0 }, people: [] } }));
    await mount(s.fetcher, <AttendanceManage />);
    await screen.findByTestId("att-links");
    expect(screen.getByTestId("att-links-linked")).toHaveTextContent("0 of 0 linked");
    expect(screen.getByTestId("att-links-pct")).toHaveTextContent("0%");
  });

  it("a refused or failed read draws nothing — not a zero — and Today still shows", async () => {
    for (const reply of [{ status: 403, body: { message: "forbidden" } }, "offline" as const]) {
      const s = server(ALL, routes(reply));
      await mount(s.fetcher, <AttendanceManage />);
      await screen.findByTestId("att-today-list");
      await waitFor(() => expect(s.sent("GET /attendance/links")).toHaveLength(1));
      expect(screen.queryByTestId("att-links")).toBeNull();
      await screen.unmount();
    }
  });

  it("a team lead without attendance.all.read sees no count and asks for none", async () => {
    const s = server([], { "GET /attendance/team/today": { status: 200, body: { date: "2026-10-14", members: [], summary: { total: 0, linked: 0 } } }, "GET /attendance/links": { status: 200, body: LINKS } });
    await mount(s.fetcher, <AttendanceManage lead />);
    await screen.findByTestId("att-team-list");
    expect(screen.queryByTestId("att-links")).toBeNull();
    expect(s.sent("GET /attendance/links")).toEqual([]);
  });

  it("says what the web says, word for word, in English and Hindi", () => {
    for (const [phone, web] of [[LINK_WORDS.en, webEn.attendanceLinks], [LINK_WORDS.hi, webHi.attendanceLinks]] as const) {
      const { heading, ...count } = phone;
      expect(heading).toBe(web.heading);
      expect(count).toEqual(web.count);
    }
  });
});
