import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabQuick } from "./lab-quick";
import { draftSummary, previewFlag } from "../lib/lab-quick-api";
import type { QuickCatalogue, QuickRange } from "../lib/lab-quick-api";

/**
 * QUICK MODE (decision 0061): Start finds the patient by the slip's visit no., takes the doctor's tests
 * and waits for Blood collected; Results colours each value against the patient's range, drafts an
 * editable summary, and Save sends what was shown.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    seen.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    const reply = handlers[`${method} ${path}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return seen;
}

const CATALOGUE: QuickCatalogue = {
  tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count", analyteIds: ["a-hb", "a-wbc"] }],
  analytes: [
    { analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", resultType: "numeric", decimals: 1, absurdLow: null, absurdHigh: null },
    { analyteId: "a-wbc", code: "WBC", nameEn: "Total leucocyte count", unit: "/µL", resultType: "numeric", decimals: 0, absurdLow: null, absurdHigh: null },
  ],
};
const RANGES: QuickRange[] = [
  { analyteId: "a-hb", low: "12.0000", high: "15.0000", text: null, criticalLow: "5.0000", criticalHigh: null, note: null },
  { analyteId: "a-wbc", low: "4000.0000", high: "11000.0000", text: null, criticalLow: null, criticalHigh: null, note: null },
];

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("the flag preview is flagFor: L, H, LL, N, and nothing without a range or a number", () => {
  const hb = RANGES[0]!;
  expect([previewFlag("9.2", hb), previewFlag("16", hb), previewFlag("4", hb), previewFlag("13", hb)]).toEqual(["L", "H", "LL", "N"]);
  expect([previewFlag("", hb), previewFlag("abc", hb), previewFlag("9", undefined)]).toEqual([null, null, null]);
});

it("the draft names each abnormal value with its range, then one line for the rest", () => {
  const base = { analyteId: "x", code: "X", refText: null };
  expect(draftSummary([
    { ...base, nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", flag: "L" },
    { ...base, nameEn: "Total leucocyte count", unit: "/µL", value: "7000", low: "4000", high: "11000", flag: "N" },
  ])).toBe("Haemoglobin is low: 9.2 g/dL (ref 12 – 15).\nOther reported parameters are within the reference range.");
  expect(draftSummary([{ ...base, nameEn: "Hb", unit: null, value: "13", low: "12", high: "15", flag: "N" }]))
    .toBe("All reported parameters are within the reference range.");
});

const ME = (perms: string[]) => ({ status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } });
const ROW = {
  id: "q-1", status: "waiting", patient: { id: "p-1", uhid: "U23011884", display: "Farida Khatoon", administrativeGender: "female", dob: "1974-03-02" },
  encounterNo: "V2610090001", tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" }],
  collectedAt: "2026-10-09T04:00:00.000Z", collectedBy: "u-1", reportedAt: null, reportedBy: null,
};
const HIT = {
  matchedOn: "visit",
  patient: { id: "p-1", uhid: "U23011884", display: "Farida Khatoon", administrativeGender: "female", dob: "1974-03-02", restricted: false },
  visit: {
    encounterId: "e-1", encounterNo: "V2610090001", serviceDate: "2026-10-09", status: "consulted", tokenNo: 12,
    doctorName: "Dr A", doctorUserId: "d-1", departmentName: "Medicine", referrerName: null,
    advised: [{ serviceId: "s-cbc", code: "CBC", name: "Complete blood count", pricePaise: 30000, alreadyOrderedItemId: null,
      orderable: { container: "edta", specimenType: "whole_blood", consentRequired: false, sensitive: false, requiresFasting: false } }],
  },
  orders: [],
};

it("START — visit no. from the slip finds the patient, the doctor's CBC comes ticked, Start waits for Blood collected", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": ME(["lab.desk.operate", "lab.results.enter", "lab.catalogue.read"]),
    "GET /api/lab/quick/catalogue": { status: 200, body: CATALOGUE },
    "GET /api/lab/quick/queue": { status: 200, body: { waiting: [], reportedToday: [] } },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [HIT], labDoctors: [] } },
    "POST /api/lab/quick/start": { status: 201, body: ROW },
  });
  renderWithProviders(<LabQuick />);

  await userEvent.type(await screen.findByLabelText("Find the patient"), "V2610090001{Enter}");
  await waitFor(() => expect(screen.getByText("Complete blood count")).toBeInTheDocument());
  const start = screen.getByRole("button", { name: "Start" });
  expect(start).toBeDisabled();
  await userEvent.click(screen.getByLabelText("Blood collected"));
  expect(start).toBeEnabled();
  await userEvent.click(start);

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Farida Khatoon is in the queue"));
  expect(seen.find((x) => x.method === "POST")!.body).toEqual({
    patientId: "p-1", encounterNo: "V2610090001", serviceIds: ["s-cbc"], bloodCollected: true,
  });
});

it("RESULTS — pick from the queue, every CBC parameter is on the form; Hb 9.2 reads L; the edited summary is what Save sends", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": ME(["lab.desk.operate", "lab.results.enter", "lab.catalogue.read"]),
    "GET /api/lab/quick/catalogue": { status: 200, body: CATALOGUE },
    "GET /api/lab/quick/queue": { status: 200, body: { waiting: [ROW], reportedToday: [] } },
    "GET /api/lab/quick/reports/q-1": { status: 200, body: { ...ROW, analyteIds: ["a-hb", "a-wbc"], lines: [], summary: "" } },
    "GET /api/lab/quick/ranges": { status: 200, body: { items: RANGES } },
    "PUT /api/lab/quick/reports/q-1": { status: 200, body: {
      ...ROW, status: "reported", reportedAt: "2026-10-09T09:00:00.000Z", reportedBy: "u-1", analyteIds: ["a-hb", "a-wbc"],
      lines: [], summary: "Hb low, repeat",
    } },
  });
  renderWithProviders(<LabQuick />);

  await userEvent.click(await screen.findByRole("button", { name: /Farida Khatoon/ }));
  const hb = await screen.findByLabelText("Haemoglobin");
  await waitFor(() => expect(screen.getByText("12 – 15")).toBeInTheDocument());
  await userEvent.type(hb, "9.2{Enter}");
  expect(hb).toHaveAttribute("data-flag", "L");
  expect(screen.getByLabelText("Total leucocyte count")).toHaveFocus();
  await userEvent.type(screen.getByLabelText("Total leucocyte count"), "7000");
  expect(screen.getByLabelText("Total leucocyte count")).toHaveAttribute("data-flag", "N");

  const summary = screen.getByLabelText("Report summary (edit freely)");
  expect(summary).toHaveValue("Haemoglobin is low: 9.2 g/dL (ref 12 – 15).\nOther reported parameters are within the reference range.");
  await userEvent.clear(summary);
  await userEvent.type(summary, "Hb low, repeat");

  await userEvent.click(screen.getByRole("button", { name: "Save report" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument());
  expect(seen.find((x) => x.method === "PUT")!.body).toEqual({
    summary: "Hb low, repeat", lines: [{ analyteId: "a-hb", value: "9.2" }, { analyteId: "a-wbc", value: "7000" }],
  });
});

const REPORTED = {
  ...ROW, status: "reported", reportedAt: "2026-10-09T09:00:00.000Z", reportedBy: "u-1",
  analyteIds: ["a-hb", "a-wbc"], groups: [{ title: "Complete blood count", analyteIds: ["a-hb", "a-wbc"] }],
  lines: [
    { analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", refText: null, flag: "L" },
    { analyteId: "a-wbc", code: "WBC", nameEn: "Total leucocyte count", unit: "/µL", value: "7000", low: "4000.0000", high: "11000.0000", refText: null, flag: "N" },
  ],
  summary: "Hb low, repeat",
};

it("FIND — suggestions appear while typing, with no Enter", async () => {
  mockRoutes({
    "GET /api/auth/me": ME(["lab.desk.operate", "lab.results.enter", "lab.catalogue.read"]),
    "GET /api/lab/quick/catalogue": { status: 200, body: CATALOGUE },
    "GET /api/lab/quick/queue": { status: 200, body: { waiting: [], reportedToday: [] } },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [HIT, { ...HIT, visit: null, patient: { ...HIT.patient, id: "p-9", uhid: "U23019999", display: "Farhan Ali" } }], labDoctors: [] } },
  });
  renderWithProviders(<LabQuick />);
  await userEvent.type(await screen.findByLabelText("Find the patient"), "Far");
  const list = await screen.findByTestId("lab-quick-suggestions");
  expect(list).toHaveTextContent("Farida Khatoon");
  expect(list).toHaveTextContent("Farhan Ali");
  await userEvent.click(screen.getByRole("button", { name: /Farida Khatoon/ }));
  expect(await screen.findByText("Complete blood count")).toBeInTheDocument();
});

it("SAVED — lab staff find a patient and see every saved report, marked not signed, with the out-of-range value", async () => {
  mockRoutes({
    "GET /api/auth/me": ME(["lab.desk.operate", "lab.results.enter", "lab.results.read", "lab.catalogue.read"]),
    "GET /api/lab/quick/catalogue": { status: 200, body: CATALOGUE },
    "GET /api/lab/quick/queue": { status: 200, body: { waiting: [], reportedToday: [] } },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [HIT], labDoctors: [] } },
    "GET /api/lab/quick/patient/p-1": { status: 200, body: { items: [REPORTED] } },
  });
  renderWithProviders(<LabQuick />);
  await userEvent.click(await screen.findByRole("button", { name: "Saved reports" }));
  await userEvent.type(screen.getByLabelText("Find the patient"), "U2301");
  await userEvent.click(await screen.findByRole("button", { name: /Farida Khatoon/ }));
  const card = await screen.findByTestId("quick-report-q-1");
  expect(card).toHaveTextContent("Quick lab · not signed");
  expect(card).toHaveTextContent("Haemoglobin: 9.2 g/dL L");
  expect(card).not.toHaveTextContent("Total leucocyte count");
  expect(card).toHaveTextContent("Hb low, repeat");
  expect(screen.getByRole("button", { name: "Open to edit" })).toBeInTheDocument();
});
