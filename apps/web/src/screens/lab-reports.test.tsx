import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabReports } from "./lab-reports";
import { istToday } from "../lib/lab-api";
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

/**
 * ═══ FD-6 / D9 — THE FIXTURE'S SERVICE DATE IS *TODAY*, AND THE CLOCK IS NOW PINNED ═══
 *
 * `lab-reports.tsx` buckets a patient's reports with `r.serviceDate === serviceDate`, where
 * `serviceDate = istToday()` is read AT RENDER. So the fixture's date and the screen's date are two
 * readings of one clock, and every gap between them is a hole.
 *
 * FD-6 was the first hole: the rows were dated `"2026-09-02"`, so from IST midnight on 2026-09-03
 * the only report stopped being "1 report ready" and became "1 earlier report on file". A hard red,
 * every run, every lane. The repair — mint the fixture date from the wall clock at module load —
 * closed that one and opened a narrower one.
 *
 * D9's flake was the narrower hole, and it is the SAME defect. The fixture date was minted when this
 * module was imported; `istToday()` is read when the screen renders. Those are different moments, so
 * a run whose import and render straddle IST midnight (18:30 UTC) buckets the report as "earlier"
 * and D9 fails with `0 reports ready · 1 earlier reports on file` — which is exactly what the
 * pharmacy lane saw three times running on 2026-09-03, and what the next run, on the other side of
 * the boundary, no longer saw. It was written up as load-sensitivity and a shared timeout budget; it
 * is neither. A timeout does not render a card, and this card rendered, fully populated, with the
 * wrong bucket. MEASURED: the two date algorithms are equivalent (0 disagreements over a week of
 * minutes, full ICU) — only the two MOMENTS differ — and forcing a straddle reproduces the string
 * above exactly.
 *
 * So the clock is pinned, the way `billing-office`, `opd-desk`, `my-day`, `opd-consult` and
 * `opd-appointments` already pin theirs. Two properties matter and neither is optional:
 *
 *   1. NOTHING here reads the wall clock — not at import, not at render. The suite's result no
 *      longer depends on the minute it happens to run in, so there is no boundary left to straddle
 *      and no third repair waiting for the next lane to find at 00:06.
 *   2. "Today in IST" has ONE definition, the screen's own `istToday()`, applied to the pinned
 *      instant. The test can no longer agree with the screen about the calendar and disagree about
 *      the formatting, because it is no longer doing its own arithmetic.
 */
const NOW_ISO = "2026-09-04T06:30:00.000Z"; // 12:00 IST — mid-day, as far from either midnight as it gets
const IST_TODAY = istToday(new Date(NOW_ISO));

const snapshot = {
  orderId: "o-1", orderNo: "L2609010102", encounterNo: "V2609010044", serviceDate: IST_TODAY,
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
    reportId: "rep-1", orderId: "o-1", orderNo: "L2609010102", encounterNo: "V2609010044", serviceDate: IST_TODAY,
    version: 1, partial: true, publishedAt: "2026-09-02T09:04:00.000Z", channels: ["print", "whatsapp", "in_person"], printCount: 0,
    orderables: ["LFT", "CBC", "GLUF"], sensitive: false, delivery: settled, deliveries: [],
    notice: { status: "sent", sentChannel: "whatsapp", sentAt: "2026-09-02T09:05:00.000Z" }, snapshot,
  }],
  pending: [{ orderId: "o-1", orderNo: "L2609010102", serviceDate: IST_TODAY, orderables: ["HBA1C"], completedCount: 0, itemCount: 1 }],
};
const RAMESH: WirePatientReports = {
  patient: { id: "p-2", uhid: "U23011990", display: "Ramesh Mahto", restricted: false },
  reports: [{
    reportId: "rep-2", orderId: "o-2", orderNo: "L2609010088", encounterNo: "V2609010031", serviceDate: IST_TODAY,
    version: 1, partial: false, publishedAt: "2026-09-02T09:11:00.000Z", channels: ["print", "whatsapp", "in_person"], printCount: 0,
    orderables: ["RFT"], sensitive: false, delivery: held, deliveries: [], notice: { status: "queued", sentChannel: null, sentAt: null }, snapshot: null,
  }],
  pending: [],
};
const hit = (id: string, name: string, uhid: string) => ({
  id, uhid, name, phone: "9876543210", administrativeGender: "female", dob: "1974-03-02", isConfidential: false, hasPhoto: false, matchedOn: ["uhid"],
});

beforeEach(() => { vi.setSystemTime(new Date(NOW_ISO)); setToken("t"); vi.stubGlobal("print", vi.fn()); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  /** Pass 2 NEW-1 — the dialog opens only once the document is on the page, never onto a blank one. */
  await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
  expect(document.querySelector(".print-doc")).not.toBeNull();
});

it("NEW-1 — with the card CLOSED, the hand-over still prints the mounted document, not a blank page", async () => {
  mockRoutes({
    "GET /api/lab/reports/register": { status: 200, body: REGISTER },
    "GET /api/patients/search": { status: 200, body: { items: [hit("p-1", "Farida Khatoon", "U23011884")] } },
    "GET /api/lab/reports/patient/p-1": { status: 200, body: FARIDA },
    "POST /api/lab/reports/rep-1/print": { status: 201, body: { deliveryId: "d-9", printCount: 1 } },
  });
  const printed: boolean[] = [];
  vi.stubGlobal("print", vi.fn(() => { printed.push(document.querySelector(".print-doc") !== null); }));
  renderWithProviders(<LabReports />);
  await waitFor(() => expect(screen.getByTestId("register")).toBeInTheDocument());
  await pickPatient("U23011884", "Farida Khatoon");
  const card = await screen.findByTestId("report-L2609010102");
  expect(document.querySelector(".print-doc")).toBeNull();
  await userEvent.type(within(card).getByLabelText("Collected by (name and relation) L2609010102"), "Farida Khatoon (self)");
  await userEvent.click(within(card).getByRole("button", { name: "Print & hand over" }));
  await waitFor(() => expect(printed).toHaveLength(1));
  expect(printed[0]).toBe(true); // THE KILL: `false` is a blank page the register says was handed over
});

it("DD6 — a HELD report reaches the browser as a verdict, never as a page; release is an APPROVAL about the order", async () => {
  const seen = mockRoutes({
    "GET /api/lab/reports/register": { status: 200, body: REGISTER },
    "GET /api/patients/search": { status: 200, body: { items: [hit("p-2", "Ramesh Mahto", "U23011990")] } },
    "GET /api/lab/reports/patient/p-2": { status: 200, body: RAMESH },
    /** The ask button appears only for a holder of `approvals.requests.create` (pass 1 F2a). */
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: ["approvals.requests.create"], scoped: { department: {}, floor: {} } } } },
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
  await userEvent.type(within(card).getByLabelText("Approval id L2609010088"), "apr-77");
  await userEvent.type(within(card).getByLabelText("Collected by (name and relation) L2609010088"), "Ramesh Mahto (self)");
  expect(release).toBeEnabled();
  await userEvent.click(release);
  await waitFor(() => expect(seen.find((s) => s.path === "/api/lab/reports/rep-2/release")).toBeDefined());
  expect(seen.find((s) => s.path === "/api/lab/reports/rep-2/release")!.body)
    .toEqual({ approvalId: "apr-77", collectorIdentity: "Ramesh Mahto (self)", channel: "print" });
});

/* ═════ 17d T7 / D8 — THE PATIENT'S COPY MAY SPEAK HINDI, AND THE NUMBERS DO NOT MOVE ═════ */

/**
 * Design board EdgeCases #25: *"Patient reads Hindi only."* The SMS and WhatsApp text were already
 * bilingual; the paper was not.
 *
 * The assertion that matters is the SECOND one. Translating a laboratory report is only safe if it
 * translates the FURNITURE — the column headings, the flag words, the notes — and leaves the
 * values, units and reference intervals exactly as signed. A report whose numbers moved with a
 * toggle would be two different documents under one signature.
 */
it("17d T7 — the Hindi copy translates the headings and the flag word, and not one number", async () => {
  mockRoutes({
    "GET /api/lab/reports/register": { status: 200, body: REGISTER },
    "GET /api/patients/search": { status: 200, body: { items: [hit("p-1", "Farida Khatoon", "U23011884")] } },
    "GET /api/lab/reports/patient/p-1": { status: 200, body: FARIDA },
  });
  renderWithProviders(<LabReports />);
  await waitFor(() => expect(screen.getByTestId("register")).toBeInTheDocument());
  await pickPatient("U23011884", "Farida Khatoon");
  const card = await screen.findByTestId("report-L2609010102");
  await userEvent.click(within(card).getByRole("button", { name: "▼" }));

  const doc = () => document.querySelector(".print-doc")!;
  /** English first: the heading and the critical-low flag word as the counter sees them by default. */
  expect(doc()).toHaveTextContent("Biological reference interval");
  expect(doc()).toHaveTextContent("Critical low");

  const toggle = within(card).getByLabelText("Hindi copy");
  expect(toggle).not.toBeChecked(); // the doctor's copy is the default (NABL convention)
  await userEvent.click(toggle);

  /** The furniture is Hindi — the heading, and the flag word the design named (गंभीर / निम्न). */
  expect(doc()).toHaveTextContent("गंभीर निम्न");
  expect(doc()).not.toHaveTextContent("Critical low");

  /**
   * THE KILL: the value, the unit and the reference interval are IDENTICAL in both languages. A
   * mutant that ran the numbers through the translator, or that swapped the snapshot for a
   * localised one, changes one of these three.
   */
  expect(doc()).toHaveTextContent("41");
  expect(doc()).toHaveTextContent("mg/dL");
  expect(doc()).toHaveTextContent("70 – 99");
  /** And the patient is still the patient: identity is data, never furniture. */
  expect(doc()).toHaveTextContent("U23011884");
  expect(doc()).toHaveTextContent("Farida Khatoon");

  /**
   * D8 — the toggle is per REPORT and reversible, asserted on the SAME render rather than in a
   * second test. That is deliberate: this file mounts the whole report centre per test, and the web
   * suite shares one worker, so an extra mount here spent enough wall-clock to time out a
   * seven-story test in ANOTHER lane's file. A test that costs a peer their budget is a test worth
   * folding.
   */
  await userEvent.click(toggle);
  expect(doc()).toHaveTextContent("Critical low");
  expect(doc()).not.toHaveTextContent("गंभीर निम्न");
});
