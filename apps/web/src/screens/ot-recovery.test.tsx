import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { OtRecovery } from "./ot-recovery";

type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const BOARD = [
  { bayResourceId: "b-1", code: "PACU-1", status: "occupied", occupantType: "encounter", occupantRef: "e-1", patientDisplay: "Patient A" },
  { bayResourceId: "b-2", code: "PACU-2", status: "free", occupantType: null, occupantRef: null, patientDisplay: null },
];

const PREVIEW = {
  encounterId: "e-1", patientId: "p-1",
  packageLines: [{ caseId: "c-1", serviceCode: "DAYCARE-DNC" }],
  implantLines: [{
    implantId: "i-1", ledgerEntryId: "l-1", serviceCode: "IMPL", qtyBase: 1,
    mrpPaisePerBase: 4_200_000, ceilingPaisePerBase: 4_500_000,
    capUnitPaise: 4_200_000, boundApplied: "mrp",
  }],
  expectedNetPaise: 10_200_000, heldPaise: 6_000_000,
  divergences: [], handoffUnbilled: [], unreturnedIssues: [], notes: {},
};

describe("OtRecovery", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the bay board: who is in each bay, and a dash where nobody is", async () => {
    mockRoutes({ "GET /api/ot/recovery/board": { status: 200, body: BOARD } });
    renderWithProviders(<OtRecovery />);
    expect(await screen.findByText("PACU-1")).toBeInTheDocument();
    // The occupied bay names its occupant; the free one says `free` ONCE, in the status column,
    // and its occupant cell is a dash. Two "free"s on one row is noise a nurse has to read past.
    // F20 — the board names the OCCUPANT, by the name this viewer may see, not the encounter id.
    expect(screen.getByText("Patient A")).toBeInTheDocument();
    expect(screen.getAllByText("free")).toHaveLength(1);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  /**
   * The clamp is SHOWN, not just applied. A cashier who can read `mrp` on the line can answer the
   * patient's "why is this ₹42,000 when your list says ₹50,000"; one shown only a number cannot.
   */
  it("previews the bill and names which bound the implant was clamped to", async () => {
    mockRoutes({
      "GET /api/ot/recovery/board": { status: 200, body: BOARD },
      "GET /api/ot/recovery/e-1/bill-preview": { status: 200, body: PREVIEW },
      "GET /api/ot/recovery/e-1/scores": { status: 200, body: [] },
    });
    renderWithProviders(<OtRecovery />);
    await userEvent.type(screen.getByLabelText(/^Encounter$/i), "e-1");

    expect(await screen.findByText(/bound: mrp/i)).toBeInTheDocument();
    // Net payable and the held deposit are both on screen, so the cash to take is visible
    // arithmetic rather than a surprise at the counter.
    expect(screen.getByText(/102000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/60000\.00/)).toBeInTheDocument();
  });

  it("renders the discharge escort refusal as a sentence", async () => {
    mockRoutes({
      "GET /api/ot/recovery/board": { status: 200, body: BOARD },
      "GET /api/ot/recovery/e-1/bill-preview": { status: 200, body: PREVIEW },
      "GET /api/ot/recovery/e-1/scores": { status: 200, body: [] },
      "POST /api/ot/recovery/e-1/discharge": {
        status: 422,
        body: { statusCode: 422, message: "escort required", code: "escort_required" },
      },
    });
    renderWithProviders(<OtRecovery />);
    await userEvent.type(screen.getByLabelText(/^Encounter$/i), "e-1");
    await userEvent.type(screen.getByLabelText(/^Case$/i), "c-1");
    await userEvent.type(screen.getByLabelText(/ISBAR acknowledged by/i), "Lata Gowda");
    await userEvent.click(screen.getByRole("button", { name: /^Discharge$/i }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("A verified escort is required at discharge.");
  });
});
