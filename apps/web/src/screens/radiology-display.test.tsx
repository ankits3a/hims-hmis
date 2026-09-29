import { screen, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyDisplay } from "./radiology-display";

/**
 * PLAN 18-S RS3 — THE IMAGING WAITING-HALL DISPLAY. Tokens and first name + initial as the server
 * sends them (a confidential patient arrives with `name: null` and shows the token alone), every
 * caption in Hindi AND English, a closed room's notice in both, and not one control.
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const BOARD = {
  day: "2026-09-29",
  rooms: [
    { deviceResourceId: "D-US", code: "US-1", name: "Ultrasound", room: "Room 7", modality: "usg", closed: null,
      now: { token: "X2609290001", name: "Asha D." }, next: [{ token: "X2609290002", name: "Ravi K." }, { token: "X2609290003", name: null }] },
    { deviceResourceId: "D-CT", code: "CT-1", name: "CT", room: "Room 4", modality: "ct", closed: "down", now: null, next: [] },
    { deviceResourceId: "D-MG", code: "MG-1", name: "Mammography", room: "Room 8", modality: "mammography", closed: "not_licensed", now: null, next: [] },
  ],
};

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("shows now and next by token with first name and initial; a confidential patient is a token alone", async () => {
  mockRoutes({ "GET /api/radiology/display": { status: 200, body: BOARD } });
  renderWithProviders(<RadiologyDisplay />);
  const us = await screen.findByTestId("hall-room-US-1");
  expect(within(us).getByTestId("hall-now-US-1")).toHaveTextContent("X2609290001");
  expect(us).toHaveTextContent("Asha D.");
  expect(us).toHaveTextContent("X2609290002Ravi K.");
  expect(us).toHaveTextContent("X2609290003");
  expect(us).toHaveTextContent("Now · अभी");
  expect(us).toHaveTextContent("Next · अगला");
});

it("a down room and an unlicensed room carry a notice in English AND Hindi, and no queue", async () => {
  mockRoutes({ "GET /api/radiology/display": { status: 200, body: BOARD } });
  renderWithProviders(<RadiologyDisplay />);
  const notices = await screen.findByTestId("hall-notices");
  expect(notices).toHaveTextContent("CT-1 is not working right now. Your booking is being moved — the desk will call you.");
  expect(notices).toHaveTextContent("CT-1 अभी काम नहीं कर रही है।");
  expect(notices).toHaveTextContent("MG-1 is closed today. Your booking is kept — the desk will call you with a new time.");
  expect(within(notices).getByText(/CT-1 is not working/).closest("[data-down]")).toHaveAttribute("data-down", "CT-1");
  expect(screen.getByTestId("hall-room-CT-1")).toHaveTextContent("Not working · बंद है");
});

it("changes nothing: no button, no input, and only the board is read", async () => {
  mockRoutes({ "GET /api/radiology/display": { status: 200, body: BOARD } });
  renderWithProviders(<RadiologyDisplay />);
  await screen.findByTestId("hall-room-US-1");
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
});
