import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { RadiologyReception } from "../radiology-reception";
import { ImagingDeskDoor } from "../../components/radiology/imaging-desk-door";
import type { WireImagingDoor } from "../../lib/radiology-api";

/**
 * ACCEPTANCE — issue #1078, spec docs/specs/1078-imaging-desk-counter.md (owner APPROVED 2026-11-14), the
 * web half: the counter is two steps, the dock's act follows what the patient in hand still owes, the
 * desk door finds a patient by UHID, and collecting is one radiology desk call.
 *
 * Slot instants are RELATIVE to the real clock, never past the last minute of today's IST day (the
 * reception suite's own lesson: a fixed time against a real clock is a time bomb).
 */
type Reply = { status: number; body: unknown };
type Seen = { key: string; url: string; body: unknown; idempotencyKey: string | null };
const seen: Seen[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      key, url: raw, body: init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown,
      idempotencyKey: headers["Idempotency-Key"] ?? null,
    });
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const IST_OFFSET_MS = 330 * 60_000;
const msLeftTodayIst = 86_400_000 - ((Date.now() + IST_OFFSET_MS) % 86_400_000);
const laterToday = new Date(Date.now() + Math.max(0, Math.min(60 * 60_000, msLeftTodayIst - 60_000))).toISOString();

const BOOKED = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", scheduledAt: laterToday, deviceResourceId: "D-CT",
  encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: new Date().toISOString(), checkedInAt: null,
};
const UNBOOKED = { ...BOOKED, studyId: "S2", accessionNo: "X2609290002", studyTypeCode: "USG-ABDO", scheduledAt: null, deviceResourceId: null };

const VIEW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", studyTypeName: "CT head, plain", modality: "ct", durationMin: 15,
  serviceId: "SVC-CT", encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi", uhid: "HMS-00000001-5",
  restricted: false, scheduledAt: laterToday, deviceResourceId: "D-CT", bedsideLocation: null, invoiceLineId: "IL1",
  intendedPayer: "self", authorisation: "invoice",
  checks: { gates: ["identity_two_factor", "pregnancy_screen"], pregnancyReason: "opened", policySource: "default", prep: [] },
  addOns: [],
};
const VIEW2 = {
  ...VIEW, studyId: "S2", accessionNo: "X2609290002", studyTypeCode: "USG-ABDO", studyTypeName: "USG whole abdomen",
  modality: "usg", durationMin: 20, serviceId: "SVC-USG", scheduledAt: null, deviceResourceId: null,
  invoiceLineId: null, authorisation: null,
  checks: { gates: ["identity_two_factor"], pregnancyReason: "not_ionising", policySource: "default", prep: ["fasting_6h"] },
};

const DEVICES = {
  devices: [
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 4", portable: false, status: "available", ionising: true, licensedNow: true },
    { id: "D-US", code: "US-1", name: "Ultrasound", modality: "usg", room: "Room 7", portable: false, status: "available", ionising: false, licensedNow: null },
  ],
};

const PREVIEW = {
  tariffVersionId: "T1", intendedPayer: "self", balances: [],
  lines: [{
    lineId: "study-S2", serviceId: "SVC-USG", serviceName: "USG whole abdomen", category: "investigation", qty: 1,
    unitPaise: 120000, grossPaise: 120000, regulatedClamp: null, candidates: [], winner: null, discountPaise: 0,
    taxableBasePaise: 120000, gst: { sacCode: "999316", rateBps: 0, exempt: true, exemptReason: "healthcare", cgstPaise: 0, sgstPaise: 0 }, netPaise: 120000,
  }],
  totals: {
    grossPaise: 120000, discountPaise: 0, taxableBasePaise: 120000, cgstPaise: 0, sgstPaise: 0,
    taxableTurnoverPaise: 0, exemptTurnoverPaise: 120000, taxSummary: [], rawTotalPaise: 120000, netPayablePaise: 120000, roundingPaise: 0,
  },
};

const DESK = [
  "radiology.schedule", "radiology.checkin", "radiology.worklist.read", "radiology.bill_decisions.manage",
  "billing.invoice.issue", "billing.receipt.record", "patients.read",
];
const me: Reply = {
  status: 200,
  body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: DESK, scoped: { department: {}, floor: {} } } },
};

const unpaidRoutes: Record<string, Reply> = {
  "GET /api/auth/me": me,
  "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
  "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
  "GET /api/radiology/devices": { status: 200, body: DEVICES },
  "GET /api/radiology/desk/studies/S2/proposal": { status: 200, body: { proposal: null } },
  "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
};

beforeEach(() => { setToken("t"); seen.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

/* ─────────────────────────────── D7 ─────────────────────────────── */

it("spec #1078 D7: the counter shows two steps; a booked, paid study's dock offers Done, an unpaid one's offers Collect", async () => {
  mockRoutes({
    "GET /api/auth/me": me,
    "GET /api/radiology/worklist": { status: 200, body: { rows: [BOOKED] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: VIEW } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/desk/arrive": {
      status: 201,
      body: { encounterNo: "V2609290001", checkedIn: [{ studyId: "S1", accessionNo: "X2609290001", gates: ["identity_two_factor", "pregnancy_screen"] }], refused: [] },
    },
  });
  const paid = renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(seen.map((s) => s.key)).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  const steps = await screen.findByRole("list", { name: "Counter steps" });
  expect(within(steps).getAllByRole("button").map((b) => b.textContent?.replace(/^\d+\s*/, "").trim()))
    .toEqual(["Bill", "Slot & slip"]);
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toHaveTextContent(/^Done/); });
  expect(screen.getByTestId("dock-act")).toBeEnabled();
  paid.unmount();

  vi.unstubAllGlobals();
  seen.length = 0;
  mockRoutes(unpaidRoutes);
  renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(seen.map((s) => s.key)).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S2"));
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toHaveTextContent("Collect ₹1,200 by Cash"); });
});

/* ─────────────────────────────── D8 ─────────────────────────────── */

const DOOR: WireImagingDoor = {
  visit: {
    encounterId: "E7", encounterNo: "V2609280007", serviceDate: "2026-09-28", status: "registered",
    doctorName: "Mehra", doctorUserId: "U-DR", departmentName: "Medicine",
    patient: { id: "P7", uhid: "HMS-00000007-1", display: "Ravi Kumar", administrativeGender: "male", dob: "1970-01-01", restricted: false },
  },
  bookActive: true, lines: [], book: [], recent: {}, orders: [],
};

it("spec #1078 D8: typing a UHID in the desk door lists the patient and today's visit", async () => {
  mockRoutes({
    "GET /api/patients/search": {
      status: 200,
      body: {
        items: [{
          id: "P7", uhid: "HMS-00000007-1", name: "Ravi Kumar", phone: "9800000007", administrativeGender: "male",
          dob: "1970-01-01", isConfidential: false, hasPhoto: false, district: "Patna", registeredOn: "2026-01-01T00:00:00.000Z",
          guardian: null, matchedOn: ["uhid"],
        }],
      },
    },
    "GET /api/radiology/desk/visits": {
      status: 200,
      body: { visits: [{ encounterNo: "V2609280007", serviceDate: "2026-09-28", status: "registered", visitType: "new", openedAt: "2026-09-28T04:00:00.000Z" }] },
    },
    "GET /api/radiology/advised": { status: 200, body: DOOR },
  });
  renderWithProviders(<ImagingDeskDoor onOpen={() => undefined} />);
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "HMS-00000007-1");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));

  const patientsList = await screen.findByTestId("desk-door-patients");
  expect(patientsList).toHaveTextContent("Ravi Kumar");
  expect(patientsList).toHaveTextContent("HMS-00000007-1");
  const visits = await screen.findByTestId("desk-door-visits");
  expect(visits).toHaveTextContent("V2609280007");
  expect(seen.find((s) => s.key === "GET /api/patients/search")!.url).toContain("q=HMS-00000007-1");
  expect(seen.find((s) => s.key === "GET /api/radiology/desk/visits")!.url).toContain("patientId=P7");
});

/* ─────────────────────────────── D9 ─────────────────────────────── */

it("spec #1078 D9: collecting calls one radiology desk route and no billing or invoice-line route", async () => {
  mockRoutes({
    ...unpaidRoutes,
    "POST /api/radiology/desk/collect": {
      status: 201,
      body: { invoiceId: "INV1", invoiceNo: "INV-0001", receiptNo: "RC-0001", totalPaise: 120000, adopted: false, linked: [{ studyId: "S2", invoiceLineId: "IL1" }] },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(seen.map((s) => s.key)).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S2"));
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Collect ₹1,200 by Cash");

  const from = seen.length;
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByTestId("bill-paid")).toHaveTextContent("INV-0001");

  const during = seen.slice(from);
  const collects = during.filter((s) => s.key === "POST /api/radiology/desk/collect");
  expect(collects).toHaveLength(1);
  expect(collects[0]!.body).toEqual({
    encounterNo: "V2609290001", studyIds: ["S2"], addOns: [], tender: { mode: "cash", amountPaise: 120000 },
  });
  expect(collects[0]!.idempotencyKey).not.toBeNull();
  expect(during.filter((s) => s.key.includes("/api/billing/") || s.key.includes("/invoice-line")).map((s) => s.key)).toEqual([]);
});
