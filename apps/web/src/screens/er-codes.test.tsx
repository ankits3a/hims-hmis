import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErCodesScreen } from "./er-codes";
import { ErPatient } from "./er-patient";
import { ErTriage } from "./er-triage";
import type { ErCodeView, ErCodes } from "@hmis/contracts";

/** ER lane 7 (#814) — the resus scribe (one tap per event, the clocks from the door), Code Grey from triage, codes from the ER patient. */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const CODE = "01J00000000000000000000C01";
const EP = "01J00000000000000000000P01";
const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const code: ErCodeView = {
  codeId: CODE, kind: "stemi", episodeId: EP, episodeNo: "ER26-000401", patientLabel: "Rakesh Verma", where: "ER-R1", calledAt: iso(-5), doorAt: iso(-40),
  endedAt: null, outcome: null, team: [{ userId: "d1", name: "Dr Ritu" }], scribe: null, leader: null,
  clocks: [
    { milestone: "ecg", targetMin: 10, from: "door", dueAt: iso(-30), metAt: null },
    { milestone: "balloon", targetMin: 90, from: "door", dueAt: iso(50), metAt: null },
  ],
  events: [], debriefed: false, backfilled: false,
};
const CODES: ErCodes = { active: [code], recent: [], serverNow: iso(0) };
const ME = { actor: { type: "user", id: "me" }, permissions: { hospital: ["er.board.view", "er.triage", "er.care", "er.codes"], scoped: { department: {}, floor: {} } } };

describe("ER lane 7 (#814) codes on the web", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") { posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json({ codeId: CODE, paged: 3, eventId: "e1", at: iso(0) }); }
      if (raw.includes(`/er/codes/${CODE}`)) return json(code);
      if (raw.endsWith("/er/codes")) return json(CODES);
      if (raw.includes("/er/care/")) return json({ episodeId: EP, stabilisedAt: null, allergyWords: [], notes: [], orders: [], meds: [], procedures: [], consents: [], calls: [], criticals: [] });
      if (raw.endsWith("/auth/me")) return json(ME);
      if (raw.includes("/er/board")) return json({ generatedAt: iso(0), wall: false, stats: { inDepartment: 0, waitingTriage: 0, longestTriageWaitMinutes: null, expected: 0, arrivalsToday: 0, broughtDeadToday: 0, boarding: 0, lwbsToday: 0, bays: { free: 0, total: 0 } }, expected: [], waiting: [], inTreatment: [] });
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the scribe sees the timer and the clocks from the door, and one tap records a shock or a milestone", async () => {
    renderWithRouter(<ErCodesScreen />, `/er/codes?code=${CODE}`);
    const box = await screen.findByTestId("er-code-case");
    expect(await within(box).findByTestId("er-code-timer")).toHaveTextContent(/^0[45]:\d\d$/);
    expect(within(box).getByTestId("er-code-clocks")).toHaveTextContent("ECG ≤ 10 min from the door");
    await userEvent.click(within(box).getByTestId("er-code-shock-200"));
    await userEvent.click(within(box).getByTestId("er-code-milestone-ecg"));
    expect(posted.map((p) => p.body)).toMatchObject([
      { codeId: CODE, kind: "shock", joules: 200 }, { codeId: CODE, kind: "milestone", milestone: "ecg" },
    ]);
  });

  it("Code Grey from the triage screen: the button, then send — security is paged to the triage desk", async () => {
    renderWithRouter(<ErTriage />, "/er/triage");
    await userEvent.click(await screen.findByTestId("er-triage-code-grey"));
    await userEvent.click(screen.getByTestId("er-triage-code-grey-send"));
    expect(posted[0]!.url).toContain("/er/codes/call");
    expect(posted[0]!.body).toMatchObject({ kind: "code_grey", place: "Triage desk" });
    expect(await screen.findByRole("status")).toHaveTextContent("Paged 3");
  });

  it("the ER patient's Code panel calls an activation on that patient", async () => {
    renderWithRouter(<ErPatient />, `/er/patient?episode=${EP}`);
    await userEvent.click(await screen.findByTestId("er-patient-bar-code"));
    await userEvent.click(screen.getByTestId("er-patient-code-stemi"));
    expect(posted[0]!.body).toMatchObject({ kind: "stemi", episodeId: EP });
  });
});
