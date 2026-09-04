import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabCollection } from "./lab-collection";
import { LabBench } from "./lab-bench";
import type { WireAwaitingRow, WireBenchArrival } from "../lib/lab-api";

/**
 * PLAN 17d T6 / D7 — **DOWNTIME AT THE SEAT** (design board EdgeCases #20).
 *
 * `ModeBanner` already tells the whole building the hospital is on paper. The board's complaint is
 * sharper than that: **the paper register and the later reconciliation are a habit rather than a
 * screen.** `labelSource: "downtime_kit"` and `downtimeKitSerial` have been accepted by
 * `printLabels` and `receive` since 17a T5 (E20 / 02 C3) and were offered by NO screen — a rail
 * with no consumer, which is the pattern this series keeps paying for.
 *
 * Every test below asserts the mode DECIDES: absence on `normal` is as much the behaviour as
 * presence on `downtime`, because a field that is always there is chrome nobody reads.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    seen.push({ method, path, body });
    const reply = handlers[`${method} ${path}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
  return seen;
}

const ME = { status: 200, body: { actor: { type: "user", id: "u-1" } } };
const mode = (m: string): Reply => ({
  status: 200, body: { mode: m, since: "2026-09-04T03:00:00.000Z", note: "fibre cut", reportId: null },
});

const FARIDA: WireAwaitingRow = {
  orderGroupId: "g-farida", patientId: "p-1", patientDisplay: "Farida Khatoon", uhid: "U23011884",
  encounterNo: "V2609010044", tokenNo: 118, priority: "routine", requiresFasting: true,
  orderableCodes: ["CBC"], itemIds: ["i-1"], placedAt: "2026-09-02T05:00:00Z", waitingMinutes: 5,
};

const ARRIVAL: WireBenchArrival = {
  specimenId: "s-9", specimenNo: "S2608300009", orderGroupId: "g-9", patientId: "p-9",
  patientDisplay: "Mohan Prasad", encounterNo: "V2608290009", container: "sst", specimenType: "serum",
  collectionSite: "ward", priority: "routine", orderableCodes: ["RFT"], itemIds: ["i-9"],
  collectedAt: "2026-08-30T05:50:00.000Z", wristbandScanned: true, waitingMinutes: 6,
};

beforeEach(() => { setToken("t"); localStorage.clear(); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); localStorage.clear(); });

/* ─────────────────────────────── the chair ─────────────────────────────── */

it("17d T6 — in downtime the chair asks for the KIT serial and sends it as the label source", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": ME,
    "GET /api/ops/mode": mode("downtime"),
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/collection/awaiting": { status: 200, body: [FARIDA] },
    "POST /api/lab/collection/labels": { status: 201, body: { specimens: [] } },
  });
  renderWithProviders(<LabCollection />);
  await userEvent.click(await screen.findByText("Farida Khatoon"));

  const notice = await screen.findByTestId("lab-downtime");
  expect(notice).toHaveTextContent(/the hospital is running on paper/i);
  // The reconciliation is on the SCREEN, which is the board's actual complaint.
  expect(notice).toHaveTextContent(/paper register/i);

  /** THE KILL: the button submits with no kit serial, and the tube goes out unidentifiable. */
  await userEvent.type(screen.getByLabelText("Scan the wristband or card"), "U23011884");
  const print = screen.getByRole("button", { name: "Record kit label" });
  expect(print).toBeDisabled();

  await userEvent.type(screen.getByLabelText("Downtime kit serial"), "DK-0241");
  expect(print).toBeEnabled();
  await userEvent.click(print);

  await waitFor(() => expect(seen.filter((c) => c.path === "/api/lab/collection/labels")).toHaveLength(1));
  expect(seen.find((c) => c.path === "/api/lab/collection/labels")!.body).toMatchObject({
    orderGroupId: "g-farida", scannedUhid: "U23011884",
    labelSource: "downtime_kit", downtimeKitSerial: "DK-0241",
  });
});

it("17d T6 — in NORMAL mode the chair shows no kit field and claims no label source", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": ME,
    "GET /api/ops/mode": mode("normal"),
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/collection/awaiting": { status: 200, body: [FARIDA] },
    "POST /api/lab/collection/labels": { status: 201, body: { specimens: [] } },
  });
  renderWithProviders(<LabCollection />);
  await userEvent.click(await screen.findByText("Farida Khatoon"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Print labels" })).toBeInTheDocument());

  // THE KILL: a field that is always there is chrome nobody reads, and its absence is the behaviour.
  expect(screen.queryByTestId("lab-downtime")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Downtime kit serial")).not.toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Scan the wristband or card"), "U23011884");
  await userEvent.click(screen.getByRole("button", { name: "Print labels" }));
  await waitFor(() => expect(seen.filter((c) => c.path === "/api/lab/collection/labels")).toHaveLength(1));
  const body = seen.find((c) => c.path === "/api/lab/collection/labels")!.body as Record<string, unknown>;
  expect(body.labelSource).toBeUndefined();
  expect(body.downtimeKitSerial).toBeUndefined();
});

/* ─────────────────────────────── the bench ─────────────────────────────── */

it("17d T6 — in downtime the bench maps the kit serial to the tube at accession", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": ME,
    "GET /api/ops/mode": mode("downtime"),
    "GET /api/lab/bench/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [ARRIVAL] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/collection/specimen/S2608300009": { status: 200, body: null },
    "POST /api/lab/bench/receive": { status: 201, body: { specimenId: "s-9", itemIds: ["i-9"] } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByTestId("arrival-S2608300009")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("Scan the tube"), "S2608300009{Enter}");

  expect(await screen.findByTestId("lab-downtime")).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Downtime kit serial on the tube"), "DK-0241");

  /**
   * Receive is NOT gated on the serial: a tube drawn before the outage still wears its printed
   * label, and demanding a kit serial for it would stop the bench working on the tubes that are
   * fine — the opposite of what a downtime screen is for.
   */
  await userEvent.click(screen.getByRole("button", { name: "Receive" }));
  await waitFor(() => expect(seen.filter((c) => c.path === "/api/lab/bench/receive")).toHaveLength(1));
  expect(seen.find((c) => c.path === "/api/lab/bench/receive")!.body).toMatchObject({
    specimenNo: "S2608300009", identifiedBy: "scan", downtimeKitSerial: "DK-0241",
  });
});

it("17d T6 — in NORMAL mode the bench sends no kit serial", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": ME,
    "GET /api/ops/mode": mode("normal"),
    "GET /api/lab/bench/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [ARRIVAL] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/collection/specimen/S2608300009": { status: 200, body: null },
    "POST /api/lab/bench/receive": { status: 201, body: { specimenId: "s-9", itemIds: ["i-9"] } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByTestId("arrival-S2608300009")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("Scan the tube"), "S2608300009{Enter}");
  await waitFor(() => expect(screen.getByRole("button", { name: "Receive" })).toBeInTheDocument());
  expect(screen.queryByTestId("lab-downtime")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Receive" }));
  await waitFor(() => expect(seen.filter((c) => c.path === "/api/lab/bench/receive")).toHaveLength(1));
  expect((seen.find((c) => c.path === "/api/lab/bench/receive")!.body as Record<string, unknown>).downtimeKitSerial)
    .toBeUndefined();
});

/**
 * ═══ THE MUTANT THAT SURVIVED, AND WHY IT MATTERS MORE THAN THE OTHERS ═══
 *
 * `mode !== "normal"` in place of `mode === "downtime"` passed every test above, because they only
 * exercised the two ends. There are FIVE modes, and **production has never left `commissioning`**
 * (17b §9.9): under that mutant the kit field and the paper-register notice would be permanent
 * furniture on the chair and the bench from the day the lab went live — the exact "chrome nobody
 * reads" that `ModeBanner`'s own header warns about, and it would be read as an instruction.
 *
 * `degraded` is the sharper half of the pair: the hospital IS struggling, the printer is fine, and
 * a kit serial demanded then is a phlebotomist inventing one.
 */
it.each(["commissioning", "ramp", "degraded"] as const)(
  "17d T6 — mode=%s is NOT downtime: no kit field at the chair",
  async (m) => {
    mockRoutes({
      "GET /api/auth/me": ME,
      "GET /api/ops/mode": mode(m),
      "GET /api/lab/collection/queue": { status: 200, body: [] },
      "GET /api/lab/collection/awaiting": { status: 200, body: [FARIDA] },
      "POST /api/lab/collection/labels": { status: 201, body: { specimens: [] } },
    });
    renderWithProviders(<LabCollection />);
    await userEvent.click(await screen.findByText("Farida Khatoon"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Print labels" })).toBeInTheDocument());
    // THE KILL: `mode !== "normal"` puts the downtime kit on every screen in a commissioning hospital.
    expect(screen.queryByTestId("lab-downtime")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Downtime kit serial")).not.toBeInTheDocument();
  },
);
