import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReception } from "./radiology-reception";

/**
 * PLAN 18-S RS3 — THE IMAGING COUNTER: Studies → Checks → Bill → Slot & slip.
 *
 * **The assertion that matters most is still what this desk CANNOT do.** The counter shows the gate
 * set check-in opens and has no control that clears one (the manifest's first separation), no
 * discount control (ruling 8) and no credit. Presence is derived: there is no "Check in" button —
 * opening the patient on the day of the slot IS the check-in.
 *
 * Every date here is RELATIVE to the real clock (a fixed-date fixture against a real clock is a
 * time bomb — the house's own lesson).
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

function bodiesOf(key: string): unknown[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

const inAnHour = new Date(Date.now() + 60 * 60_000).toISOString();
const tomorrow = new Date(Date.now() + 36 * 60 * 60_000).toISOString();

const ROW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", scheduledAt: inAnHour, deviceResourceId: "D-CT",
  encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: new Date().toISOString(), checkedInAt: null,
};
const UNBOOKED = { ...ROW, studyId: "S2", accessionNo: "X2609290002", studyTypeCode: "USG-ABDO", scheduledAt: null, deviceResourceId: null };

const VIEW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", studyTypeName: "CT head, plain", modality: "ct", durationMin: 15,
  serviceId: "SVC-CT", encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi", uhid: "HMS-00000001-5",
  restricted: false, scheduledAt: inAnHour, deviceResourceId: "D-CT", bedsideLocation: null, invoiceLineId: null,
  intendedPayer: "self", authorisation: null,
  checks: { gates: ["identity_two_factor", "pregnancy_screen"], pregnancyReason: "opened", policySource: "default", prep: [] },
  addOns: [],
};
const VIEW2 = {
  ...VIEW, studyId: "S2", accessionNo: "X2609290002", studyTypeCode: "USG-ABDO", studyTypeName: "USG whole abdomen",
  modality: "usg", durationMin: 20, serviceId: "SVC-USG", scheduledAt: null, deviceResourceId: null,
  checks: { gates: ["identity_two_factor"], pregnancyReason: "not_ionising", policySource: "default", prep: ["fasting_6h"] },
};

const DEVICES = {
  devices: [
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 4", portable: false, status: "available", ionising: true, licensedNow: true },
    { id: "D-US", code: "US-1", name: "Ultrasound", modality: "usg", room: "Room 7", portable: false, status: "available", ionising: false, licensedNow: null },
    { id: "D-UP", code: "USG-P1", name: "Portable ultrasound", modality: "usg", room: null, portable: true, status: "available", ionising: false, licensedNow: null },
    { id: "D-PX", code: "PX-1", name: "Portable X-ray", modality: "xray", room: null, portable: true, status: "available", ionising: true, licensedNow: false },
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

function me(perms: string[]): Reply {
  return { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } };
}
const DESK = ["radiology.schedule", "radiology.checkin", "radiology.worklist.read", "billing.invoice.issue", "radiology.bill_decisions.manage"];

/** The numbered steps, not the dock (which also names the next step). */
async function stepTo(name: RegExp): Promise<void> {
  const steps = await screen.findByRole("list", { name: "Counter steps" });
  await userEvent.click(within(steps).getByRole("button", { name }));
}

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("opening the patient on the day of the slot IS the check-in, and the gate set is DISPLAYED, never cleared", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: VIEW } },
    "POST /api/radiology/studies/S1/check-in": {
      status: 201, body: { studyId: "S1", status: "checked_in", policySource: "default", pregnancyReason: "opened", gates: ["identity_two_factor", "pregnancy_screen"] },
    },
  });
  renderWithProviders(<RadiologyReception />);
  /** No presence-only button anywhere. */
  expect(screen.queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  await waitFor(() => { expect(calls).toContain("POST /api/radiology/studies/S1/check-in"); });

  await stepTo(/Checks/);
  const checks = await screen.findByTestId("counter-checks");
  expect(checks).toHaveTextContent("Checks opened at arrival");
  expect(checks).toHaveTextContent("Pregnancy screen");
  expect(screen.getByTestId("pregnancy-question")).toHaveTextContent(/any chance you are pregnant/);
  expect(screen.getByTestId("pregnancy-question")).toHaveTextContent(/गर्भवती/);

  /** THE SEPARATION: no control on this screen satisfies a gate. */
  expect(screen.queryByRole("button", { name: /Satisfy|Waive|Override|^Yes$|^No$/ })).not.toBeInTheDocument();
  expect(calls.some((c) => c.includes("/gates/"))).toBe(false);
});

it("a study booked for another day is not checked in by opening it, and a desk without the grant checks in nobody", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...ROW, scheduledAt: tomorrow }] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: { ...VIEW, scheduledAt: tomorrow } } },
  });
  const first = renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  await screen.findByTestId("patient-in-hand");
  expect(calls).not.toContain("POST /api/radiology/studies/S1/check-in");
  first.unmount();

  vi.unstubAllGlobals();
  calls.length = 0;
  mockRoutes({
    "GET /api/auth/me": me(["radiology.schedule"]),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: VIEW } },
  });
  renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  await screen.findByTestId("patient-in-hand");
  expect(calls).not.toContain("POST /api/radiology/studies/S1/check-in");
});

it("the Checks step tells the patient the prep in English AND Hindi, from the server's prep keys", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Checks/);
  const checks = await screen.findByTestId("counter-checks");
  await waitFor(() => { expect(checks).toHaveTextContent("Nothing to eat for 6 hours before."); });
  expect(checks).toHaveTextContent("जांच से 6 घंटे पहले कुछ न खाएँ।");
  expect(checks).toHaveTextContent("Checks the prep bay will open");
});

it("self-pay: Enter on the dock collects through the house invoice, then LINKS the raised line to the study", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
    "POST /api/billing/invoices": {
      status: 201,
      body: { invoiceId: "INV1", invoiceNo: "INV-0001", totals: PREVIEW.totals, receiptId: "R1", receiptNo: "RC-0001", allocatedPaise: 120000, unallocatedPaise: 0, creditExtended: false, settlement: { state: "settled", outstandingPaise: 0 }, warnings: [] },
    },
    "GET /api/billing/invoices/INV1": { status: 200, body: { invoice: { id: "INV1", invoiceNo: "INV-0001" }, lines: [{ id: "IL1", serviceId: "SVC-USG", lineNo: 1 }], settlement: {} } },
    "POST /api/radiology/studies/S2/invoice-line": { status: 201, body: { studyId: "S2", invoiceLineId: "IL1" } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  expect(await screen.findByTestId("bill-total")).toHaveTextContent("₹1,200");
  /** No discount control at the counter (ruling 8) — the note, not a field. */
  expect(screen.getByTestId("discount-note")).toHaveTextContent(/No discount at the counter/);
  expect(screen.queryByRole("textbox", { name: /discount/i })).not.toBeInTheDocument();
  /** Film and CD are not in the tariff: a note, never a price the desk invents. */
  expect(screen.getByTestId("addons-note")).toHaveTextContent(/not in the tariff yet/);

  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Collect ₹1,200 by Cash");
  fireEvent.keyDown(document.body, { key: "Enter" });

  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S2/invoice-line")).toEqual([{ invoiceLineId: "IL1" }]); });
  expect(bodiesOf("POST /api/billing/invoices")[0]).toMatchObject({
    patientId: "P1", encounterId: "V2609290001",
    lines: [{ lineId: "study-S2", serviceId: "SVC-USG", qty: 1 }],
    receipt: { tenders: [{ mode: "cash", amountPaise: 120000 }] },
  });
  expect(await screen.findByTestId("bill-paid")).toHaveTextContent("INV-0001");
});

it("no open drawer: no tender is offered and the dock cannot collect", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  await screen.findByTestId("bill-total");
  expect(await within(screen.getByTestId("counter-bill")).findByText(/cash drawer is not open/)).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Cash" })).not.toBeInTheDocument();
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  expect(calls).not.toContain("POST /api/billing/invoices");
});

it("UPI waits for its reference before the dock will collect", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  await userEvent.click(await screen.findByRole("radio", { name: "UPI" }));
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  await userEvent.type(screen.getByLabelText("UPI reference (UTR)"), "412233445566");
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Collect ₹1,200 by UPI");
});

it("an earlier bill already charges the service: the desk links THAT line instead of billing twice", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
    "POST /api/billing/invoices": {
      status: 409,
      body: { statusCode: 409, code: "duplicate_invoice_refused", message: "invoice INV-0009 already charges this service on this visit", detail: { invoiceId: "INV9" } },
    },
    "GET /api/billing/invoices/INV9": { status: 200, body: { invoice: { id: "INV9", invoiceNo: "INV-0009" }, lines: [{ id: "IL9", serviceId: "SVC-USG", lineNo: 1 }] } },
    "POST /api/radiology/studies/S2/invoice-line": { status: 201, body: { studyId: "S2", invoiceLineId: "IL9" } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByText(/already charges this service/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Link the paid line to the study" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S2/invoice-line")).toEqual([{ invoiceLineId: "IL9" }]); });
  expect(bodiesOf("POST /api/billing/invoices")).toHaveLength(1);
});

it("STAT: nothing is collected at the counter — the bill follows", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...UNBOOKED, priority: "stat" }] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, priority: "stat", authorisation: "stat" } } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  expect(await screen.findByText(/the bill follows/)).toBeInTheDocument();
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Slot & slip");
  expect(calls).not.toContain("POST /api/billing/invoices/preview");
});

it("Slot: only machines of the study's kind; the typed time is IST; a portable machine sends the bed", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S2/schedule": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await waitFor(() => {
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a machine", "US-1 · Ultrasound · Room 7", "USG-P1 · Portable ultrasound · portable",
    ]);
  });
  await userEvent.selectOptions(select, "D-UP");
  fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "2026-10-01T10:00" } });
  await userEvent.type(screen.getByLabelText("At the bedside"), "Ward 3 · bed 12");
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Book USG-P1 at 10:00");
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S2/schedule")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S2/schedule")[0]).toEqual({
    deviceResourceId: "D-UP", scheduledAt: "2026-10-01T04:30:00.000Z", bedsideLocation: "Ward 3 · bed 12",
  });
});

it("Slot refusals: the server's words, the seat that fixes it, and the payment warning with the way back to Bill", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S2/schedule": {
      status: 409, body: { statusCode: 409, code: "slot_taken", message: "US-1 (Ultrasound) is busy with X2609290009 from 04:30" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  /** Unpaid self-pay: the room would refuse `payment_required` — said here, with the way back to Bill. */
  expect(await screen.findByText(/room will refuse this scan/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Go to the Bill step" })).toBeInTheDocument();
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /US-1/ });
  await userEvent.selectOptions(select, "D-US");
  await userEvent.click(screen.getByTestId("dock-act"));
  const refusal = (await screen.findByText(/busy with X2609290009/)).closest("[data-refusal]") as HTMLElement;
  expect(refusal).toHaveAttribute("data-refusal", "slot_taken");
  expect(within(refusal).getByRole("link", { name: /diary/ })).toHaveAttribute("href", "/radiology/diary");
});

it("device_not_portable: the server's words and the explicit bring-to-the-department, with a real time", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice", bedsideLocation: "Ward 3 · bed 12" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S2/schedule": {
      status: 422, body: { statusCode: 422, code: "device_not_portable", message: "US-1 (Ultrasound) is not a portable unit and cannot be taken to a bedside" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /US-1/ });
  await userEvent.selectOptions(select, "D-US");
  fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "2026-10-01T11:15" } });
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByText(/not a portable unit/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Bring to the department instead" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S2/schedule")).toHaveLength(2); });
  expect(bodiesOf("POST /api/radiology/studies/S2/schedule")[1]).toEqual({
    deviceResourceId: "D-US", scheduledAt: "2026-10-01T05:45:00.000Z", bedsideLocation: null,
  });
});

it("an unlicensed ionising machine cannot be booked from the desk, and says who fixes it", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...UNBOOKED, studyTypeCode: "XR-CHEST" }] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, modality: "xray", studyTypeName: "X-ray chest PA", authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /PX-1/ });
  await userEvent.selectOptions(select, "D-PX");
  expect(await screen.findByText(/no active AERB licence today/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Radiation safety files the licence/ })).toHaveAttribute("href", "/radiology/radiation-safety");
  expect(screen.getByTestId("dock-act")).toBeDisabled();
});

it("the slip shows the token, where and when, the prep in both languages, and never claims the message was sent", async () => {
  const booked = { ...UNBOOKED, scheduledAt: inAnHour, deviceResourceId: "D-US" };
  mockRoutes({
    "GET /api/auth/me": me(["radiology.schedule"]),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [booked] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, scheduledAt: inAnHour, deviceResourceId: "D-US", authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const slip = await screen.findByTestId("counter-slip");
  expect(within(slip).getByTestId("slip-token")).toHaveTextContent("X2609290002");
  await waitFor(() => { expect(slip).toHaveTextContent("US-1 · Room 7"); });
  expect(slip).toHaveTextContent("Nothing to eat for 6 hours before.");
  expect(slip).toHaveTextContent("जांच से 6 घंटे पहले कुछ न खाएँ।");
  expect(slip).toHaveTextContent(/queued.*has not been sent/);
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Clear the desk");
});

it("walk-in now books AND checks in — the patient is standing at the counter", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S2/walk-in": { status: 201, body: {} },
    "POST /api/radiology/studies/S2/check-in": { status: 201, body: { studyId: "S2", status: "checked_in", gates: ["identity_two_factor"], pregnancyReason: "not_ionising", policySource: "default" } },
  });
  renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  await userEvent.click(await screen.findByRole("button", { name: "Now · walk in" }));
  await waitFor(() => { expect(calls).toContain("POST /api/radiology/studies/S2/check-in"); });
  expect(calls.indexOf("POST /api/radiology/studies/S2/walk-in")).toBeLessThan(calls.indexOf("POST /api/radiology/studies/S2/check-in"));
});

it("Clocks running: an order waiting over 30 minutes to be booked opens the clocks by itself", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...UNBOOKED, createdAt: new Date(Date.now() - 45 * 60_000).toISOString() }] } },
  });
  renderWithProviders(<RadiologyReception />);
  expect(await screen.findByTestId("desk-clocks")).toHaveTextContent(/Asha Devi · USG-ABDO waiting to be booked, 4\d min/);
});

/**
 * PLAN 18-S RS2 — the ordering door is the seat's CENTRE (18a-iv D1), and the right-hand list stays
 * the queue alone ("nothing duplicates the right list").
 */
it("mounts the ordering door in the centre, never in the right-hand queue", async () => {
  mockRoutes({ "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } } });
  renderWithProviders(<RadiologyReception />);
  const door = await screen.findByTestId("imaging-desk-door");
  expect(screen.getByTestId("station-right")).not.toContainElement(door);
  expect(screen.getByLabelText("Visit number")).toBeInTheDocument();
});
