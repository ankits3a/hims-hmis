import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabCollection } from "./lab-collection";

/**
 * PLAN 17b T8 — collection.
 *
 * **The refusal path asserted here is `tube_mismatch`** (DD10 / E1): two Ram Kumars in one morning
 * queue. The server refuses before any tube exists and flags the near-miss; this file asserts that
 * the screen shows the refusal WITH BOTH UHIDs in it — a phlebotomist told only "wrong patient"
 * cannot tell whether they scanned the wrong band or picked the wrong row.
 *
 * The second property is structural: **the scan field is never pre-filled and is CLEARED after
 * every print.** A field carrying the UHID the screen already knows turns the check into a
 * formality.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const handler = handlers[key];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler() : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("DD10 — a wrong scan shows the server's refusal WITH BOTH UHIDs, and no tube is listed", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "POST /api/lab/collection/labels": { status: 422, body: {
      statusCode: 422, code: "tube_mismatch",
      message: "the scan says HMS-00000102-5 and this order group belongs to HMS-00000101-7 — no label was printed",
    } },
  });
  renderWithProviders(<LabCollection />);

  await userEvent.type(screen.getByLabelText(/Order group/), "g-1");
  await userEvent.type(screen.getByLabelText(/Scan the wristband/), "HMS-00000102-5");
  await userEvent.click(screen.getByRole("button", { name: "Print labels" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/HMS-00000102-5/));
  expect(screen.getByRole("alert")).toHaveTextContent(/HMS-00000101-7/);
  expect(screen.queryByText("Tubes labelled")).not.toBeInTheDocument();
});

it("the scan is CLEARED after a successful print — the next patient is scanned, not remembered", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "POST /api/lab/collection/labels": { status: 201, body: {
      specimens: [{ specimenId: "s-1", specimenNo: "S2608300001", specimenType: "serum",
        container: "sst", itemIds: ["i-1"] }],
    } },
  });
  renderWithProviders(<LabCollection />);

  await userEvent.type(screen.getByLabelText(/Order group/), "g-1");
  const scan = screen.getByLabelText(/Scan the wristband/);
  await userEvent.type(scan, "HMS-00000101-7");
  await userEvent.click(screen.getByRole("button", { name: "Print labels" }));

  await waitFor(() => expect(screen.getByText("S2608300001")).toBeInTheDocument());
  expect(scan).toHaveValue("");
  /** And the button is disabled again until the NEXT patient is scanned. */
  expect(screen.getByRole("button", { name: "Print labels" })).toBeDisabled();
});

it("02 A2 — unticking the wristband warns about the named re-check the bench will require", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "POST /api/lab/collection/labels": { status: 201, body: {
      specimens: [{ specimenId: "s-1", specimenNo: "S2608300001", specimenType: "serum",
        container: "sst", itemIds: ["i-1"] }],
    } },
  });
  renderWithProviders(<LabCollection />);
  await userEvent.type(screen.getByLabelText(/Order group/), "g-1");
  await userEvent.type(screen.getByLabelText(/Scan the wristband/), "HMS-00000101-7");
  await userEvent.click(screen.getByRole("button", { name: "Print labels" }));
  await waitFor(() => expect(screen.getByText("S2608300001")).toBeInTheDocument());

  /**
   * IT DEFAULTS TO UNTICKED (close review C2): the screen must not assert a physical act nobody
   * performed. The warning is therefore visible immediately, ABOVE the Draw button, and the draw is
   * NOT refused — the consequence is named before it bites.
   */
  expect(screen.getByRole("checkbox", { name: /Wristband was scanned/ })).not.toBeChecked();
  expect(screen.getByText(/named identity re-check/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Drawn" })).toBeEnabled();

  await userEvent.click(screen.getByRole("checkbox", { name: /Wristband was scanned/ }));
  expect(screen.queryByText(/named identity re-check/)).not.toBeInTheDocument();
});
