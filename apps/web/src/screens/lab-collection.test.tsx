import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabCollection, mergeQueue } from "./lab-collection";
import type { WireAwaitingRow, WireCollectionRow } from "../lib/lab-api";

/**
 * PLAN 17c T2 — the chair. Asserted on ORDER (STAT first, then draw order on the tubes), on the
 * scan discipline (an empty UHID field every time; a tube scan that names another tube is refused
 * before the draw is recorded), and on the server's refusal shown verbatim with both UHIDs.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    seen.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler() : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
  return seen;
}

const FARIDA: WireAwaitingRow = {
  orderGroupId: "g-farida", patientId: "p-1", patientDisplay: "Farida Khatoon", uhid: "U23011884",
  encounterNo: "V2609010044", tokenNo: 118, priority: "routine", requiresFasting: true,
  orderableCodes: ["CBC", "LFT", "GLUF"], itemIds: ["i-1", "i-2", "i-3"], placedAt: "2026-09-02T05:00:00Z", waitingMinutes: 5,
};
const KAMLA: WireAwaitingRow = {
  ...FARIDA, orderGroupId: "g-kamla", patientId: "p-2", patientDisplay: "Kamla Devi", uhid: "U23011999",
  encounterNo: "V2609010097", tokenNo: 121, priority: "stat", requiresFasting: false, orderableCodes: ["TROPI"], itemIds: ["i-9"], waitingMinutes: 2,
};
const tube = (no: string, container: string, specimenType: string, codes: string[]): WireCollectionRow => ({
  specimenId: `s-${no}`, specimenNo: no, orderGroupId: "g-farida", patientId: "p-1", patientName: "Farida Khatoon",
  patientDisplay: "Farida Khatoon", uhid: "U23011884", encounterNo: "V2609010044", tokenNo: 118,
  labelledAt: "2026-09-02T05:15:00Z", waitingMinutes: 1, specimenType, container, collectionSite: "opd",
  priority: "routine", requiresFasting: container === "fluoride", orderableCodes: codes, itemIds: codes.map((c) => `i-${c}`),
});
/** Minted in NUMBER order by the server; the seat must show them in DRAW order. */
const TUBES = [
  tube("S2609010211", "fluoride", "plasma", ["GLUF"]),
  tube("S2609010212", "edta", "whole_blood", ["CBC"]),
  tube("S2609010213", "sst", "serum", ["LFT"]),
];

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("mergeQueue — STAT first, then the longest wait; labelled tubes come sorted by order of draw", () => {
  const q = mergeQueue([FARIDA, KAMLA], TUBES);
  expect(q.map((e) => e.key)).toEqual(["a-g-kamla", "a-g-farida", "l-g-farida"]);
  const labelled = q[2]!;
  expect(labelled.kind === "labelled" && labelled.tubes.map((t) => t.container)).toEqual(["sst", "edta", "fluoride"]);
});

it("the queue calls the token; the UHID field is EMPTY; a wrong scan shows the server's refusal with both UHIDs", async () => {
  mockRoutes({
    "GET /api/lab/collection/awaiting": { status: 200, body: [FARIDA, KAMLA] },
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "POST /api/lab/collection/labels": { status: 422, body: {
      statusCode: 422, code: "tube_mismatch",
      message: "the scan says U23011999 and this order group belongs to U23011884 — no label was printed",
    } },
  });
  renderWithProviders(<LabCollection />);
  await waitFor(() => expect(screen.getByText("Kamla Devi")).toBeInTheDocument());
  const list = within(screen.getByRole("region", { name: "Waiting" }));
  const rows = list.getAllByRole("button");
  /** STAT first, and the token is what the chair reads out. */
  expect(rows[0]).toHaveTextContent("T-121");
  expect(rows[0]).toHaveTextContent(/stat/i);
  expect(rows[1]).toHaveTextContent("T-118");
  expect(rows[1]).toHaveTextContent("fasting");

  await userEvent.click(rows[1]!);
  expect(screen.getByTestId("patient-card")).toHaveTextContent("Farida Khatoon");
  const scan = screen.getByLabelText(/Scan the wristband/);
  expect(scan).toHaveValue("");
  expect(screen.getByRole("button", { name: "Print labels" })).toBeDisabled();
  await userEvent.type(scan, "U23011999");
  await userEvent.click(screen.getByRole("button", { name: "Print labels" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/U23011999/));
  expect(screen.getByRole("alert")).toHaveTextContent(/U23011884/);
  expect(screen.queryByTestId("tubes")).not.toBeInTheDocument();
});

it("labels print in ORDER OF DRAW with one barcode each; a tube scan that names another tube is refused; every tube scanned lights Drawn", async () => {
  let printed = false;
  const seen = mockRoutes({
    "GET /api/lab/collection/awaiting": () => ({ status: 200, body: printed ? [] : [FARIDA] }),
    "GET /api/lab/collection/queue": () => ({ status: 200, body: printed ? TUBES : [] }),
    "POST /api/lab/collection/labels": () => {
      printed = true;
      return { status: 201, body: { specimens: TUBES.map((t) => ({ specimenId: t.specimenId, specimenNo: t.specimenNo, specimenType: t.specimenType, container: t.container, itemIds: t.itemIds })) } };
    },
    "POST /api/lab/collection/collect": { status: 201, body: { specimenId: "x", specimenNo: "x", itemIds: [] } },
  });
  renderWithProviders(<LabCollection />);
  await waitFor(() => expect(screen.getByText("Farida Khatoon")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Farida Khatoon/ }));
  await userEvent.type(screen.getByLabelText(/Scan the wristband/), "U23011884");
  await userEvent.click(screen.getByRole("button", { name: "Print labels" }));

  await waitFor(() => expect(screen.getByTestId("tubes")).toBeInTheDocument());
  /** The scan is cleared and the wristband fact travels with the group. */
  expect(screen.getByText(/Wristband scanned/)).toBeInTheDocument();
  const tubes = within(screen.getByTestId("tubes")).getAllByRole("listitem");
  expect(tubes.map((li) => li.textContent)).toEqual([
    expect.stringMatching(/1.*gold.*serum.*LFT.*S2609010213/s),
    expect.stringMatching(/2.*lavender.*whole_blood.*CBC.*S2609010212/s),
    expect.stringMatching(/3.*grey.*plasma.*GLUF.*S2609010211/s),
  ]);
  /** One label per tube, each carrying its own barcode. */
  for (const no of ["S2609010211", "S2609010212", "S2609010213"]) {
    expect(within(screen.getByTestId(`label-${no}`)).getByTestId("barcode").querySelectorAll("rect").length).toBeGreaterThan(30);
  }
  expect(screen.getByRole("button", { name: /Drawn/ })).toBeDisabled();

  /** A scan of tube 2's number in tube 1's field is refused on the screen — no draw recorded. */
  await userEvent.type(screen.getByLabelText("Scan the tube S2609010213"), "S2609010212");
  expect(screen.getByRole("alert")).toHaveTextContent(/S2609010212/);
  expect(seen.filter((s) => s.path === "/api/lab/collection/collect")).toHaveLength(0);

  await userEvent.clear(screen.getByLabelText("Scan the tube S2609010213"));
  await userEvent.type(screen.getByLabelText("Scan the tube S2609010213"), "S2609010213");
  await waitFor(() => expect(seen.filter((s) => s.path === "/api/lab/collection/collect")).toHaveLength(1));
  expect(seen.find((s) => s.path === "/api/lab/collection/collect")!.body).toEqual({ specimenId: "s-S2609010213", wristbandScanned: true });
  await userEvent.type(screen.getByLabelText("Scan the tube S2609010212"), "S2609010212");
  await userEvent.type(screen.getByLabelText("Scan the tube S2609010211"), "S2609010211");
  await waitFor(() => expect(screen.getByRole("button", { name: /Drawn — 3 tubes/ })).toBeEnabled());
});

it("a ward tube labelled elsewhere carries NO wristband fact here and says the bench will re-check", async () => {
  const seen = mockRoutes({
    "GET /api/lab/collection/awaiting": { status: 200, body: [] },
    "GET /api/lab/collection/queue": { status: 200, body: [TUBES[1]!] },
    "POST /api/lab/collection/collect": { status: 201, body: { specimenId: "x", specimenNo: "x", itemIds: [] } },
  });
  renderWithProviders(<LabCollection />);
  await waitFor(() => expect(screen.getByText("Farida Khatoon")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Farida Khatoon/ }));
  expect(screen.getByText(/named identity re-check/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Scan the tube S2609010212"), "S2609010212");
  await waitFor(() => expect(seen.filter((s) => s.path === "/api/lab/collection/collect")).toHaveLength(1));
  expect(seen.find((s) => s.path === "/api/lab/collection/collect")!.body).toEqual({ specimenId: "s-S2609010212", wristbandScanned: false });
});
