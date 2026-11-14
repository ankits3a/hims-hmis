import { act, screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../../lib/api";
import { resetRealtimeClientForTests } from "../../lib/realtime";
import { renderWithProviders } from "../../test-utils";
import { RadiologyRoom } from "../radiology-room";

/**
 * ACCEPTANCE — issue #1083, spec docs/specs/1083-imaging-live-lists.md (owner APPROVED 2026-11-14), the
 * web half: a modality room's list does not wait for its poll when the floor moves.
 *
 * jsdom ships no WebSocket a test can drive, so the transport is this fake (the opd-display /
 * realtime.test.ts precedent; a test file never imports another test file). The room list polls every
 * 30 s; this test runs in well under one poll, so any extra read of the list is the frame's doing.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  simulateOpen(): void { this.readyState = 1; this.onopen?.(); }
  simulateMessage(obj: unknown): void { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

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

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const TECH = ["radiology.acquire", "radiology.worklist.read", "radiology.gates.satisfy", "radiology.checkin"];
const DEVICES = {
  devices: [
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 104", portable: false, status: "available", ionising: true, licensedNow: true },
  ],
};
const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "R2609290001", status: "ready", priority: "routine", studyTypeCode: "CT-HEAD",
  scheduledAt: ago(-30), deviceResourceId: "D-CT", encounterNo: "V1", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: ago(40), checkedInAt: ago(25), ...over,
});
const LIST = "GET /api/radiology/worklist";
const listReads = (): number => calls.filter((c) => c === LIST).length;

beforeEach(() => {
  setToken("t");
  calls.length = 0;
  FakeWebSocket.instances = [];
  resetRealtimeClientForTests();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

it("spec #1083 D4 — the room list refetches when a frame arrives on imaging:floor, and not for another topic", async () => {
  mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: TECH, scoped: { department: {}, floor: {} } } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    [LIST]: { status: 200, body: { rows: [row({ studyId: "A", patientName: "Ready One" })] } },
  });
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1" }} />);
  const list = within(await screen.findByTestId("room-list"));
  await waitFor(() => { expect(list.getAllByRole("button")).toHaveLength(1); });

  // The screen subscribed: a socket exists, and once authenticated it asks for the floor topic.
  const ws = FakeWebSocket.instances[0];
  expect(ws).toBeDefined();
  await act(async () => { ws!.simulateOpen(); });
  await act(async () => { ws!.simulateMessage({ type: "authed", userId: "u-1" }); });
  const subscribed = ws!.sent.map((s) => JSON.parse(s) as { type: string; topics?: string[] }).filter((m) => m.type === "subscribe");
  expect(subscribed.flatMap((m) => m.topics ?? [])).toContain("imaging:floor");

  const before = listReads();
  // A frame on a topic the room does not watch reads nothing.
  await act(async () => {
    ws!.simulateMessage({ type: "event", topic: "imaging:release", name: "imaging.report_handed_over", seq: 7, occurredAt: ago(0), payload: { studyId: "A" } });
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(listReads()).toBe(before);

  // A frame on the floor topic reads the list again, now — not at the next poll.
  await act(async () => {
    ws!.simulateMessage({ type: "event", topic: "imaging:floor", name: "imaging.study_acquired", seq: 8, occurredAt: ago(0), payload: { studyId: "A" } });
  });
  await waitFor(() => { expect(listReads()).toBe(before + 1); });
});
