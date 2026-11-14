import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { sayParams } from "../../lib/use-copilot";
import { renderWithProviders } from "../../test-utils";
import { ImagingCopilot, withSubject } from "./imaging-copilot";

/**
 * #1082 — the imaging stations' copilot column: the study in hand rides in front of a question that names
 * no number (the ask route's one subject mechanism), the imaging params are said in words, and an act is
 * one tap on an option and one on Confirm — nothing is sent to `/copilot/confirm` before the second.
 */
const calls: { key: string; body: unknown }[] = [];
function mockRoutes(handlers: Record<string, unknown>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push({ key, body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)) });
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = handlers[key];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("puts the study in hand in front of a question that names no number, and leaves one that does alone", () => {
  expect(withSubject("report ready hai?", "X2611140001")).toBe("X2611140001 report ready hai?");
  expect(withSubject("X2611140002 ka report ready hai?", "X2611140001")).toBe("X2611140002 ka report ready hai?");
  expect(withSubject("how many reads are past target", null)).toBe("how many reads are past target");
});

it("says a gate, a seat, a state and film/CD in words, and passes the accession through", () => {
  const t = (k: string): string => `T(${k})`;
  expect(sayParams("copilot.answer.radStudyHeld", { accession: "X2611140001", gate: "renal_function", seat: "prep", more: 0 }, t, "en"))
    .toEqual({ accession: "X2611140001", gate: "T(radiology.gate.renal_function)", seat: "T(copilot.rad.seat.prep)", more: 0 });
  expect(sayParams("copilot.answer.radStudyState", { accession: "X1", state: "checked_in" }, t, "en").state).toBe("T(radiology.worklist.state.checked_in)");
  expect(sayParams("copilot.answer.radMediaDone", { accession: "X1", kind: "cd" }, t, "en").kind).toBe("T(copilot.rad.media.cd)");
});

it("an act is a tap on the option and a tap on Confirm, and only the second reaches /copilot/confirm", async () => {
  const proposal = { id: "P1", v: 1, tool: "radiology.request_film_cd" };
  mockRoutes({
    "GET /api/copilot/notice": { seen: true },
    "POST /api/copilot/ask": {
      answer: {
        key: "copilot.answer.radMediaPick", params: { count: 1 },
        payload: { kind: "imagingPick", act: "media", options: [{ proposal: 0, accessionNo: "X2611140001", study: "USG abdomen", kind: "cd" }] },
      },
      proposals: [proposal], source: "phrasebook", intent: "radiology.request_film_cd", askId: "A1",
    },
    "POST /api/copilot/confirm": { outcome: "done", answer: { key: "copilot.answer.radMediaDone", params: { accession: "X2611140001", kind: "cd" } } },
  });
  const user = userEvent.setup();
  renderWithProviders(<ImagingCopilot subject="X2611140001" patientName="Asha Devi" />);
  await user.type(screen.getByTestId("agent-ask"), "CD chahiye{Enter}");
  await waitFor(() => expect(calls.find((c) => c.key === "POST /api/copilot/ask")?.body).toMatchObject({ question: "X2611140001 CD chahiye", terms: ["Asha Devi"] }));
  await user.click(await screen.findByTestId("imaging-copilot-option-0"));
  expect(calls.filter((c) => c.key === "POST /api/copilot/confirm")).toHaveLength(0);
  await user.click(screen.getByTestId("imaging-copilot-confirm"));
  await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/copilot/confirm").map((c) => c.body)).toEqual([{ proposal }]));
  expect(await screen.findByText("CD asked for X2611140001.")).toBeInTheDocument();
});
