import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReception } from "./radiology-reception";

/**
 * PLAN 18a T9 — imaging reception.
 *
 * **The assertion that matters is what this desk CANNOT do.** `radiology_receptionist` holds
 * `radiology.schedule` and not `radiology.gates.satisfy`, so the screen books, moves and checks in
 * — and when the gate set opens it can only display it. A "clear" button here would be the first
 * separation in `manifest.ts` undone in the client.
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
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const ROW = {
  studyId: "S1", accessionNo: "X2608310001", status: "scheduled", priority: "routine",
  studyTypeCode: "USG-OBS-ANOMALY", scheduledAt: null, deviceResourceId: null,
  encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: true, restricted: true,
};

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("checks a patient in and DISPLAYS the gate set it cannot clear", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "POST /api/radiology/studies/S1/check-in": {
      status: 201,
      body: {
        studyId: "S1", status: "checked_in", policySource: "default", pregnancyReason: "not_ionising",
        gates: ["chaperone_present", "form_f", "identity_two_factor"],
      },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByRole("button", { name: "Check in" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent("Form F (PCPNDT)");
  expect(status).toHaveTextContent("Chaperone");

  /** THE SEPARATION: no control on this screen satisfies a gate. */
  expect(screen.queryByRole("button", { name: /Satisfy|Waive|Override/ })).not.toBeInTheDocument();
  expect(calls.some((c) => c.includes("/gates/"))).toBe(false);
});

it("books a slot and walks a patient in", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "POST /api/radiology/studies/S1/schedule": { status: 201, body: {} },
    "POST /api/radiology/studies/S1/walk-in": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByRole("button", { name: "Book" }));
  await userEvent.click(screen.getByRole("button", { name: "Walk in" }));
  expect(calls).toContain("POST /api/radiology/studies/S1/schedule");
  expect(calls).toContain("POST /api/radiology/studies/S1/walk-in");
});

/**
 * `slot_taken` is a 409 a receptionist acts on by picking another time — so the desk sees the
 * server's own words rather than "could not complete".
 */
it("shows a slot clash with the server's own message", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "POST /api/radiology/studies/S1/schedule": {
      status: 409,
      body: { statusCode: 409, message: "device D1 already has a live booking at that time", code: "slot_taken" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByRole("button", { name: "Book" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already has a live booking.*slot_taken/);
});
