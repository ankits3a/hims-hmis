import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabQBench, LabQCollect, LabQReports } from "./lab-qchain";
import type { QuickCatalogue, QuickRange } from "../lib/lab-quick-api";

/**
 * OWNER 2026-10-11 — the quick chain after the counter (spec SPEC-lab-quick-chain-2026-10-11.md):
 * /lab/qcollect confirms blood and stamps a sample number; /lab/qbench saves a draft or completes;
 * /lab/qreports prints and hands over, or sends back to the bench.
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
    const h = handlers[`${method} ${path}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    const reply = typeof h === "function" ? h() : h;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return seen;
}

const ME = (perms: string[]): Reply => ({ status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } });
const PATIENT = { id: "p-1", uhid: "U23011884", display: "Farida Khatoon", administrativeGender: "female", dob: "1974-03-02" };
const CBC = { serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" };
const ROW = {
  id: "q-1", status: "waiting", patient: PATIENT, encounterNo: "V2610110001", tests: [CBC],
  collectedAt: "2026-10-11T04:00:00.000Z", collectedBy: "u-1", reportedAt: null, reportedBy: null,
  orderId: "o-1", orderNo: "L2610110001", sampleNo: "S2610110007", handedOverAt: null, handedOverBy: null,
};
const CATALOGUE: QuickCatalogue = {
  tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count", analyteIds: ["a-hb"] }],
  analytes: [{ analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", resultType: "numeric", decimals: 1, absurdLow: null, absurdHigh: null }],
};
const RANGES: QuickRange[] = [{ analyteId: "a-hb", low: "12.0000", high: "15.0000", text: null, criticalLow: null, criticalHigh: null, note: null }];
const REPORT = {
  ...ROW, status: "reported", reportedAt: "2026-10-11T08:00:00.000Z", reportedBy: "u-1",
  analyteIds: ["a-hb"], groups: [{ title: "Complete blood count", analyteIds: ["a-hb"] }],
  lines: [{ analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", refText: null, flag: "L" }],
  summary: "Hb low", collectedByName: "Sunita", reportedByName: "Pravin",
  hospital: { name: "CRK", address: "Hajipur", hotline: "1", emergency: "2", email: "e", website: "w" }, visitQrSvg: null,
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("QUICK COLLECT — a patient waiting for blood; Blood collected confirms it and says the sample number", async () => {
  let collected = false;
  const seen = mockRoutes({
    "GET /api/auth/me": ME(["lab.worklist.read", "lab.desk.operate"]),
    "GET /api/lab/quick/collect": () => ({ status: 200, body: collected ? [] : [{
      orderId: "o-1", orderNo: "L2610110001", encounterNo: "V2610110001", placedAt: new Date().toISOString(), priority: "routine",
      patient: PATIENT, tests: [CBC],
    }] }),
    "POST /api/lab/quick/collect/o-1": () => { collected = true; return { status: 200, body: ROW }; },
  });
  renderWithProviders(<LabQCollect />);
  const queue = await screen.findByTestId("collect-queue");
  await waitFor(() => expect(queue).toHaveTextContent("Farida Khatoon"));
  expect(queue).toHaveTextContent("CBC");
  await userEvent.click(within(queue).getByRole("button", { name: "Blood collected Farida Khatoon" }));
  await waitFor(() => expect(screen.getByTestId("collected-toast")).toHaveTextContent("S2610110007"));
  expect(seen.some((s) => s.method === "POST" && s.path === "/api/lab/quick/collect/o-1")).toBe(true);
  await waitFor(() => expect(screen.getByTestId("collect-queue")).not.toHaveTextContent("Farida Khatoon"));
});

it("QUICK BENCH — Save draft sends complete:false and keeps it on the bench; Save & Complete sends complete:true and says it went to Quick Reports", async () => {
  let n = 0;
  const seen = mockRoutes({
    "GET /api/auth/me": ME(["lab.results.enter", "lab.catalogue.read"]),
    "GET /api/lab/quick/catalogue": { status: 200, body: CATALOGUE },
    "GET /api/lab/quick/queue": { status: 200, body: { waiting: [ROW], reportedToday: [] } },
    "GET /api/lab/quick/reports/q-1": { status: 200, body: { ...ROW, analyteIds: ["a-hb"], groups: [], lines: [], summary: "" } },
    "GET /api/lab/quick/ranges": { status: 200, body: { items: RANGES } },
    "PUT /api/lab/quick/reports/q-1": () => {
      n += 1;
      return { status: 200, body: n === 1 ? { ...REPORT, status: "draft", reportedAt: null, reportedBy: null } : REPORT };
    },
  });
  renderWithProviders(<LabQBench />);
  const queue = await screen.findByTestId("bench-queue");
  await waitFor(() => expect(queue).toHaveTextContent("S2610110007"));
  await userEvent.click(within(queue).getByRole("button", { name: "Enter results Farida Khatoon" }));
  const hb = await screen.findByLabelText(/Haemoglobin/);
  await userEvent.type(hb, "9.2");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(seen.filter((s) => s.method === "PUT")).toHaveLength(1));
  expect((seen.find((s) => s.method === "PUT")!.body as { complete: boolean }).complete).toBe(false);
  expect(await screen.findByText("Draft saved.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save & Complete" }));
  await waitFor(() => expect(screen.getByTestId("completed-toast")).toHaveTextContent("Quick Reports"));
  expect((seen.filter((s) => s.method === "PUT")[1]!.body as { complete: boolean }).complete).toBe(true);
});

it("QUICK REPORTS — open a completed report, Print & Hand over records the hand-over; Send back returns it to the bench", async () => {
  const opened = vi.fn(() => ({ document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() }));
  vi.stubGlobal("open", opened);
  const seen = mockRoutes({
    "GET /api/auth/me": ME(["lab.reports.print", "lab.results.enter"]),
    "GET /api/lab/quick/ready": { status: 200, body: { ready: [{ ...ROW, status: "reported", reportedAt: REPORT.reportedAt, reportedBy: "u-1" }], handedOverToday: [] } },
    "GET /api/lab/quick/ready/q-1": { status: 200, body: REPORT },
    "POST /api/lab/quick/reports/q-1/hand-over": { status: 200, body: { ...ROW, status: "reported", handedOverAt: "x", handedOverBy: "u-1" } },
    "POST /api/lab/quick/reports/q-1/send-back": { status: 200, body: { ...ROW, status: "draft" } },
  });
  renderWithProviders(<LabQReports />);
  const list = await screen.findByTestId("ready-list");
  await waitFor(() => expect(list).toHaveTextContent("Farida Khatoon"));
  await userEvent.click(within(list).getByRole("button", { name: "Open Farida Khatoon" }));
  await waitFor(() => expect(screen.getByTestId("report-preview")).toHaveTextContent("Haemoglobin"));
  expect(screen.getByTestId("report-preview")).toHaveTextContent("9.2 L");
  expect(screen.getByTestId("report-preview")).toHaveTextContent("not signed");
  await userEvent.click(screen.getByRole("button", { name: /Print & Hand over/ }));
  await waitFor(() => expect(screen.getByTestId("reports-toast")).toHaveTextContent("handed over"));
  expect(seen.some((s) => s.path === "/api/lab/quick/reports/q-1/hand-over")).toBe(true);

  await userEvent.click(within(await screen.findByTestId("ready-list")).getByRole("button", { name: "Open Farida Khatoon" }));
  await userEvent.click(await screen.findByRole("button", { name: /Send back to Quick Bench/ }));
  await waitFor(() => expect(screen.getByTestId("reports-toast")).toHaveTextContent("sent back"));
  expect(seen.some((s) => s.path === "/api/lab/quick/reports/q-1/send-back")).toBe(true);
});
