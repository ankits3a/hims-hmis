import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabReports } from "./lab-reports";
import type { WireDeliveryRegisterRow, WirePatientReports } from "../lib/lab-api";

/**
 * PLAN 17c T5 — the report centre. The register says how each report went out; the counter's
 * hand-over follows the SERVER's verdict — a held report never reaches the browser as a page, and
 * the release path is an APPROVAL, not a button; a sensitive report is in person only.
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

const snapshot = {
  orderId: "o-1", orderNo: "L2609010102", encounterNo: "V2609010044", serviceDate: "2026-09-02",
  patient: { id: "p-1", uhid: "U23011884", name: "Farida Khatoon", sex: "female", dob: "1974-03-02" },
  orderingClinicianId: "u-doc",
  signatory: { userId: "u-path", username: "dr.iyer", signedAt: "2026-09-02T09:04:00.000Z" },
  partial: true, notes: [],
  panels: [{
    orderItemId: "i-1", orderableCode: "GLUF", nameEn: "Glucose, fasting", nameHi: null,
    discipline: "biochemistry", specimenNo: "S2609010213", sensitive: false,
    analytes: [{ analyteCode: "GLUF", nameEn: "Glucose, fasting", nameHi: null, value: "41.0000", unit: "mg/dL", flag: "LL",
      refLow: "70.0000", refHigh: "99.0000", refText: null, refNote: null, deltaFlag: true, verifiedAt: "2026-09-02T09:04:00.000Z", pathologistReviewPending: false }],
  }],
};
const settled = { allowed: true, reason: "settled" as const, unpaidInvoiceIds: [] as string[], outstandingPaise: 0 };
const held = { allowed: false, reason: "unpaid_invoices" as const, unpaidInvoiceIds: ["inv-2"], outstandingPaise: 115000 };

const REGISTER: WireDeliveryRegisterRow[] = [
  { reportId: "rep-1", orderId: "o-1", orderNo: "L2609010102", patientId: "p-1", patientDisplay: "Farida Khatoon",
    orderables: ["LFT", "CBC", "GLUF"], sensitive: false, partial: true, version: 1, publishedAt: "2026-09-02T09:04:00.000Z", signedBy: "dr.iyer",
    delivery: settled, deliveries: [{ deliveryId: "d-1", channel: "whatsapp", at: "2026-09-02T09:05:00.000Z", collectorIdentity: null, deliveredBy: "u-sys" }],
    notice: { status: "sent", sentChannel: "whatsapp", sentAt: "2026-09-02T09:05:00.000Z" } },
  { reportId: "rep-2", orderId: "o-2", orderNo: "L2609010088", patientId: "p-2", patientDisplay: "Ramesh Mahto",
    orderables: ["RFT"], sensitive: false, partial: false, version: 1, publishedAt: "2026-09-02T09:11:00.000Z", signedBy: "dr.iyer",
    delivery: held, deliveries: [], notice: { status: "queued", sentChannel: null, sentAt: null } },
  { reportId: "rep-3", orderId: "o-3", orderNo: "L2609010094", patientId: "p-3", patientDisplay: "Patient A",
    orderables: ["HIV"], sensitive: true, partial: false, version: 1, publishedAt: "2026-09-02T08:22:00.000Z", signedBy: "dr.iyer",
    delivery: settled, deliveries: [], notice: null },
];

const FARIDA: WirePatientReports = {
  patient: { id: "p-1", uhid: "U23011884", display: "Farida Khatoon", restricted: false },
  reports: [{
    reportId: "rep-1", orderId: "o-1", orderNo: "L2609010102", encounterNo: "V2609010044", serviceDate: "2026-09-02",
    version: 1, partial: true, publishedAt: "2026-09-02T09:04:00.000Z", channels: ["print", "whatsapp", "in_person"], printCount: 0,
    orderables: ["LFT", "CBC", "GLUF"], sensitive: false, delivery: settled, deliveries: [],
    notice: { status: "sent", sentChannel: "whatsapp", sentAt: "2026-09-02T09:05:00.000Z" }, snapshot,
  }],
  pending: [{ orderId: "o-1", orderNo: "L2609010102", serviceDate: "2026-09-02", orderables: ["HBA1C"], completedCount: 0, itemCount: 1 }],
};
const RAMESH: WirePatientReports = {
  patient: { id: "p-2", uhid: "U23011990", display: "Ramesh Mahto", restricted: false },
  reports: [{
    reportId: "rep-2", orderId: "o-2", orderNo: "L2609010088", encounterNo: "V2609010031", serviceDate: "2026-09-02",
    version: 1, partial: false, publishedAt: "2026-09-02T09:11:00.000Z", channels: ["print", "whatsapp", "in_person"], printCount: 0,
    orderables: ["RFT"], sensitive: false, delivery: held, deliveries: [], notice: { status: "queued", sentChannel: null, sentAt: null }, snapshot: null,
  }],
  pending: [],
};
const hit = (id: string, name: string, uhid: string) => ({
  id, uhid, name, phone: "9876543210", administrativeGender: "female", dob: "1974-03-02", isConfidential: false, hasPhoto: false, matchedOn: ["uhid"],
});

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

async function pickPatient(uhid: string, name: string): Promise<void> {
  await userEvent.type(screen.getByLabelText("Search"), uhid);
  await waitFor(() => expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
}

it("the register says how each report went out: WhatsApp sent, HELD with the amount, in person only", async () => {
  mockRoutes({
    "GET /api/lab/reports/register": { status: 200, body: REGISTER },
  });
  renderWithProviders(<LabReports />);
  await waitFor(() => expect(screen.getByTestId("register-L2609010102")).toBeInTheDocument());
  expect(screen.getByTestId("register-L2609010102")).toHaveTextContent(/PARTIAL/);
  expect(screen.getByTestId("register-L2609010102")).toHaveTextContent(/notice sent whatsapp/);
  expect(screen.getByTestId("register-L2609010088")).toHaveTextContent(/HELD · ₹1,150.00/);
  expect(screen.getByTestId("register-L2609010088")).toHaveTextContent(/print waits for the slip/);
  expect(screen.getByTestId("register-L2609010094")).toHaveTextContent(/in person only/);
  expect(screen.getByTestId("register-L2609010094")).toHaveTextContent("Patient A");
  /** The doctor's screen is never held. */
  expect(screen.getAllByText("on the doctor's screen")).toHaveLength(3);
});

it("D9 — a settled report prints with the collector's name and relation; the paper is the snapshot the server sent", async () => {
  const seen = mockRoutes({
    "GET /api/lab/reports/register": { status: 200, body: REGISTER },
    "GET /api/patients/search": { status: 200, body: { items: [hit("p-1", "Farida Khatoon", "U23011884")] } },
    "GET /api/lab/reports/patient/p-1": { status: 200, body: FARIDA },
    "POST /api/lab/reports/rep-1/print": { status: 201, body: { deliveryId: "d-9", printCount: 1 } },
  });
  renderWithProviders(<LabReports />);
  await waitFor(() => expect(screen.getByTestId("register")).toBeInTheDocument());
  await pickPatient("U23011884", "Farida Khatoon");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("1 report ready"));
  expect(screen.getByTestId("patient-card")).toHaveTextContent("1 result still to come");
  const card = screen.getByTestId("report-L2609010102");
  expect(card).toHaveTextContent(/PARTIAL/);
  const print = within(card).getByRole("button", { name: "Print & hand over" });
  expect(print).toBeDisabled();
  await userEvent.type(within(card).getByLabelText("Collected by (name and relation) L2609010102"), "Farida Khatoon (self)");
  expect(print).toBeEnabled();
  await userEvent.click(within(card).getByRole("button", { name: "▼" }));
  expect(screen.getByText("U23011884", { selector: ".print-doc *" })).toBeInTheDocument();
  await userEvent.click(print);
  await waitFor(() => expect(seen.find((s) => s.path === "/api/lab/reports/rep-1/print")).toBeDefined());
  expect(seen.find((s) => s.path === "/api/lab/reports/rep-1/print")!.body).toEqual({ channel: "print", collectorIdentity: "Farida Khatoon (self)" });
});

it("DD6 — a HELD report reaches the browser as a verdict, never as a page; release is an APPROVAL about the order", async () => {
  const seen = mockRoutes({
    "GET /api/lab/reports/register": { status: 200, body: REGISTER },
    "GET /api/patients/search": { status: 200, body: { items: [hit("p-2", "Ramesh Mahto", "U23011990")] } },
    "GET /api/lab/reports/patient/p-2": { status: 200, body: RAMESH },
    "POST /api/approvals": { status: 201, body: { approvalId: "apr-77", instanceId: "wf-1" } },
    "POST /api/lab/reports/rep-2/release": { status: 201, body: { deliveryId: "d-8", printCount: 1 } },
  });
  renderWithProviders(<LabReports />);
  await waitFor(() => expect(screen.getByTestId("register")).toBeInTheDocument());
  await pickPatient("U23011990", "Ramesh Mahto");
  await waitFor(() => expect(screen.getByTestId("report-L2609010088")).toBeInTheDocument());
  const card = screen.getByTestId("report-L2609010088");
  expect(within(card).getByRole("alert")).toHaveTextContent(/₹1150.00 outstanding on 1 invoice/);
  expect(within(card).queryByRole("button", { name: "Print & hand over" })).toBeNull();
  expect(document.querySelector(".print-doc")).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "Ask the billing manager to release" }));
  await waitFor(() => expect(card).toHaveTextContent(/approval apr-77/));
  const asked = seen.find((s) => s.path === "/api/approvals")!.body as { typeKey: string; subject: { type: string; id: string }; amountPaise: number };
  expect([asked.typeKey, asked.subject.id, asked.amountPaise]).toEqual(["lab_release_unpaid", "o-2", 115000]);

  const release = within(card).getByRole("button", { name: "Release and hand over" });
  expect(release).toBeDisabled();
  await userEvent.type(within(card).getByLabelText("Approval id"), "apr-77");
  await userEvent.type(within(card).getByLabelText("Collected by (name and relation) L2609010088"), "Ramesh Mahto (self)");
  expect(release).toBeEnabled();
  await userEvent.click(release);
  await waitFor(() => expect(seen.find((s) => s.path === "/api/lab/reports/rep-2/release")).toBeDefined());
  expect(seen.find((s) => s.path === "/api/lab/reports/rep-2/release")!.body)
    .toEqual({ approvalId: "apr-77", collectorIdentity: "Ramesh Mahto (self)", channel: "print" });
});
