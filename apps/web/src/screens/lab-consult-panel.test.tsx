import { screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabResultsPanel } from "./opd-consult";

/**
 * PLAN 17d T5 / D6 — **THE LABORATORY PANEL ON THE CONSULT SCREEN**, and the one thing it must not
 * do: let an unsigned number stand next to a signed one without saying so.
 *
 * Design board EdgeCases #18: *"Doctor wants the numbers by phone before the pathologist signs."*
 * That request is constant and legitimate in an Indian hospital, so the panel shows the values —
 * from a SECOND route, in a SECOND list, with the word on every row.
 *
 * The panel had no test of its own before this file: `opd-consult.test.tsx` mocks no lab route, so
 * every assertion below is new coverage rather than a widened one.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): { path: string }[] {
  const seen: { path: string }[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!;
    seen.push({ path });
    const reply = handlers[`GET ${path}`];
    if (reply === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    }));
  }));
  return seen;
}

const SIGNED = [{
  orderId: "o-1", orderItemId: "i-1", orderableCode: "TSH", orderableName: "TSH",
  analyteCode: "TSH", analyteName: "TSH", value: "2.10", unit: "uIU/mL",
  flag: "N", refLow: "0.35", refHigh: "4.94", refText: null,
  deltaFlag: false, verifiedAt: "2026-09-03T10:00:00.000Z", pathologistReviewPending: false,
}];

const UNSIGNED = [{
  orderId: "o-2", orderItemId: "i-2", orderableCode: "RFT", orderableName: "Renal function",
  analyteCode: "K", analyteName: "Potassium", value: "6.80", unit: "mmol/L",
  flag: "HH", refLow: "3.50", refHigh: "5.10", refText: null,
  deltaFlag: false, pathologistReviewPending: false,
  verified: false as const, enteredAt: "2026-09-03T15:40:00.000Z",
  enteredById: "u-bench", entryMode: "manual",
}];

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("17d T5 — the unsigned values appear in their OWN list, every row stamped provisional", async () => {
  mockRoutes({
    "GET /api/lab/results/encounter/V2609030001": { status: 200, body: SIGNED },
    "GET /api/lab/results/encounter/V2609030001/provisional": { status: 200, body: UNSIGNED },
  });
  renderWithProviders(<LabResultsPanel visitNo="V2609030001" />);

  await waitFor(() => expect(screen.getByTestId("lab-results")).toHaveTextContent(/2\.10/));
  const provisional = await screen.findByTestId("lab-results-provisional");

  /**
   * THE KILL: the two lists merged. A potassium of 6.8 nobody has signed, sitting in the verified
   * list, is an unsigned number wearing a signed one's clothes in front of a prescriber.
   */
  const signedList = within(screen.getByTestId("lab-results")).getAllByRole("list")[0]!;
  expect(within(signedList).queryByText("Potassium")).not.toBeInTheDocument();
  expect(within(provisional).getByText("Potassium")).toBeInTheDocument();

  /** The stamp is on the ROW, not once on the heading — a heading scrolls off and a row does not. */
  const row = within(provisional).getByRole("listitem");
  expect(within(row).getByText("Provisional")).toBeInTheDocument();
  expect(row).toHaveTextContent(/6\.80/);
});

/**
 * C1's lesson, applied to the unsigned list: a failed query is NOT a clinical negative. "No
 * provisional results" is a claim made to a prescriber, and it must never mean "the network was
 * unhappy" — so a 403 renders the block not at all rather than as an empty one.
 */
it("17d T5 — a refused provisional query renders NOTHING, never an empty state", async () => {
  mockRoutes({
    "GET /api/lab/results/encounter/V2609030001": { status: 200, body: SIGNED },
    "GET /api/lab/results/encounter/V2609030001/provisional": { status: 403, body: { code: "permission_denied" } },
  });
  renderWithProviders(<LabResultsPanel visitNo="V2609030001" />);

  await waitFor(() => expect(screen.getByTestId("lab-results")).toHaveTextContent(/2\.10/));
  expect(screen.queryByTestId("lab-results-provisional")).not.toBeInTheDocument();
  // The SIGNED half is unaffected: one door failing never blinds the other.
  expect(screen.getByTestId("lab-results")).toHaveTextContent(/2\.10/);
});

it("17d T5 — with nothing unsigned the block is absent, and the signed list stands alone", async () => {
  mockRoutes({
    "GET /api/lab/results/encounter/V2609030001": { status: 200, body: SIGNED },
    "GET /api/lab/results/encounter/V2609030001/provisional": { status: 200, body: [] },
  });
  renderWithProviders(<LabResultsPanel visitNo="V2609030001" />);
  await waitFor(() => expect(screen.getByTestId("lab-results")).toHaveTextContent(/2\.10/));
  expect(screen.queryByTestId("lab-results-provisional")).not.toBeInTheDocument();
});
